import { Db } from 'larvitdb-pg';
import { Log, LogInstance } from 'larvitutils';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import { DbConInternal } from 'larvitdb-pg/build/models';

const topLogPrefix = 'larvitdbmigration-pg: src/index.ts: ';

type DbMigrationOptions = {
	dbDriver: Db;
	log?: LogInstance;
	migrationScriptPath?: string;
	tableName?: string;
};

class DbMigration {
	private dbDriver: Db;
	private instanceLogPrefix: string;
	private log: LogInstance;
	public readonly instanceUuid: string = uuid();
	public readonly migrationScriptPath: string;
	public readonly tableName: string;

	constructor(options: DbMigrationOptions) {
		this.dbDriver = options.dbDriver;

		if (options.log) {
			this.log = options.log;
		} else {
			this.log = new Log();
		}

		if (options.tableName) {
			this.tableName = options.tableName;
		} else {
			this.tableName = 'db_version';
		}

		if (options.migrationScriptPath) {
			this.migrationScriptPath = options.migrationScriptPath;
		} else {
			this.migrationScriptPath = process.cwd() + '/dbmigration';
		}

		// Resolve ./ paths to be relative to application path
		if (this.migrationScriptPath.substring(0, 2) === './') {
			this.migrationScriptPath = process.cwd() + '/' + this.migrationScriptPath.substring(2);
		}

		this.instanceLogPrefix = topLogPrefix + 'uuid: "' + this.instanceUuid + '" - ';
	}

	public async run() {
		const { tableName, log, instanceLogPrefix } = this;
		const logPrefix = instanceLogPrefix + 'run() - ';
		const db = this.dbDriver;
		const dbCon = await db.getConnection();
		let locked = false;

		log.verbose(logPrefix + 'Getting advisory lock');

		while (!locked) {
			const { rows } = await dbCon.query('SELECT pg_try_advisory_lock(1) AS "isLocked"');
			if (Array.isArray(rows) && rows.length === 1 && rows[0].isLocked === true) {
				log.debug(logPrefix + 'Lock obtained, moving on');
				locked = true;
			} else {
				log.verbose(logPrefix + 'Another process is running migrations, retrying to get lock in 50ms');
				await new Promise(resolve => setTimeout(resolve, 50));
			}
		}

		// Create table if it does not exist
		try {
			await dbCon.query('CREATE TABLE "' + tableName + '" ('
				+ 'id integer NOT NULL DEFAULT 1,'
				+ 'version integer NOT NULL DEFAULT 0,'
				+ 'running integer NOT NULL DEFAULT 0,'
				+ 'CONSTRAINT db_version_pkey PRIMARY KEY (id)'
			+ ');', undefined, { doNotLogErrors: true });
		} catch (err) {
			if (err.code === '42P07') {
				// This happens when a table already exists, and we're ok with that
				log.verbose(logPrefix + 'Table "' + tableName + '" already exists');
			} else {
				log.error(logPrefix + 'Error creating table, err: "' + err.message + '", code: "' + err.code + '"');
				log.verbose(logPrefix + 'Releasing advisory lock');
				await dbCon.query('SELECT pg_advisory_unlock(1);');
				await dbCon.end();
				throw err;
			}
		}

		// Insert first record if it does not exist
		await dbCon.query('INSERT INTO "' + tableName + '" VALUES(1, 0, 0) ON CONFLICT DO NOTHING;');

		// Get current version
		const verRes = await dbCon.query('SELECT version FROM "' + tableName + '";');
		const curVer = verRes.rows[0].version;

		log.info(logPrefix + 'Current database version is ' + curVer);

		// Run scripts
		try {
			await this.runScripts(dbCon, curVer + 1);
		} catch (err) {
			log.info(logPrefix + 'Error running migration scripts, err: "' + err.message + '"');

			// Release advisory lock
			await dbCon.query('SELECT pg_advisory_unlock(1);');
			await dbCon.end();
			throw err;
		}

		// Unlock table
		await dbCon.query('UPDATE "' + tableName + '" SET running = 0;');

		// Release advisory lock
		await dbCon.query('SELECT pg_advisory_unlock(1);');
		await dbCon.end();
	}

	public async runScripts(dbCon: DbConInternal, startVersion: number = 0): Promise<void> {
		const { tableName, log, migrationScriptPath, instanceLogPrefix } = this;
		const logPrefix = instanceLogPrefix + 'runScripts() - tableName: "' + tableName + '" - ';
		const that = this;

		log.verbose(logPrefix + 'Started with startVersion: "' + startVersion + '" in path: "' + migrationScriptPath + '"');

		// Get items in the migration script path
		const items = await new Promise((resolve, reject) => {
			fs.readdir(migrationScriptPath, (err, itemsInFolder) => {
				if (err) {
					log.info(logPrefix + 'Could not read migration script path "' + migrationScriptPath + '", err: ' + err.message);
					reject(err);
				} else {
					resolve(itemsInFolder);
				}
			});
		}) as string[];
		log.debug(logPrefix + 'Got the following migration scripts from disk: "' + JSON.stringify(items) + '"');

		async function finalize() {
			log.debug(logPrefix + 'Finalizing script running with setting db version and running next script');

			await dbCon.query('UPDATE "' + tableName + '" SET version = ' + Number(startVersion) + ';');
			log.debug(logPrefix + 'Database updated to version: "' + Number(startVersion) + '"');

			await that.runScripts(dbCon, Number(startVersion) + 1);
		}

		// Loop through the items and see what kind of migration scripts it is
		for (let i = 0; items.length !== i; i++) {
			const item = items[i];

			if (item === startVersion + '.js') {
				log.info(logPrefix + 'Found js migration script #' + startVersion + ', running it now.');

				const migrationScript = require(migrationScriptPath + '/' + startVersion + '.js');

				await migrationScript({ db: dbCon, log });
				log.debug(logPrefix + 'Js migration script #' + startVersion + ' ran. Updating database version and moving on.');
				await finalize();
			} else if (item === startVersion + '.sql') {
				log.info(logPrefix + 'Found sql migration script #' + startVersion + ', running it now.');

				await dbCon.query(fs.readFileSync(migrationScriptPath + '/' + items[i]).toString());

				log.info(logPrefix + 'Sql migration script #' + startVersion + ' ran. Updating database version and moving on.');

				await finalize();
			}
		}
	}
}

export { DbMigration };
