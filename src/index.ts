import { Log, LogInstance, Utils } from 'larvitutils';
import { Db } from 'larvitdb-pg';
import fs from 'fs';
import uuid from 'uuid/v4';

const topLogPrefix = 'larvitdbmigration-pg: src/index.ts: ';

type DbMigrationOptions = {
	dbDriver: Db;
	log?: LogInstance;
	tableName?: string;
	migrationScriptPath?: string;
};

class DbMigration {
	public readonly tableName: string;
	public readonly migrationScriptPath: string;
	public readonly instanceUuid: string = uuid();
	private lUtils: Utils;
	private log: LogInstance;
	private dbDriver: Db;
	private instanceLogPrefix: string;

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

		this.lUtils = new Utils({ log: this.log });
	}

	public async run() {
		const { tableName, log, instanceLogPrefix } = this;
		const logPrefix = instanceLogPrefix + 'run() - ';
		const db = this.dbDriver;

		// Create table if it does not exist
		try {
			await db.query('CREATE TABLE "' + tableName + '" ('
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
				throw err;
			}
		}

		// Insert first record if it does not exist
		await db.query('INSERT INTO "' + tableName + '" VALUES(1, 0, 0) ON CONFLICT DO NOTHING;');

		// Lock table by setting the running column to 1
		await this.getLock();

		// Get current version
		const verRes = await db.query('SELECT version FROM "' + tableName + '";');
		const curVer = verRes.rows[0].version;

		log.info(logPrefix + 'Current database version is ' + curVer);

		// Run scripts
		await this.runScripts(curVer + 1);

		// Unlock table
		await db.query('UPDATE "' + tableName + '" SET running = 0;');
	}

	public async runScripts(startVersion: number = 0): Promise<void> {
		const { tableName, log, migrationScriptPath, instanceLogPrefix } = this;
		const logPrefix = instanceLogPrefix + 'runScripts() - tableName: "' + tableName + '" - ';
		const db = this.dbDriver;
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

		async function finalize() {
			log.debug(logPrefix + 'Finalizing script running with setting db version and running next script');

			await db.query('UPDATE "' + tableName + '" SET version = ' + Number(startVersion) + ';');
			log.debug(logPrefix + 'Database updated to version: "' + Number(startVersion) + '"');

			await that.runScripts(Number(startVersion) + 1);
		}

		// Loop through the items and see what kind of migration scripts it is
		for (let i = 0; items.length !== i; i++) {
			const item = items[i];

			if (item === startVersion + '.js') {
				log.info(logPrefix + 'Found js migration script #' + startVersion + ', running it now.');

				const migrationScript = require(migrationScriptPath + '/' + startVersion + '.js');

				await migrationScript({ db, log });
				log.debug(logPrefix + 'Js migration script #' + startVersion + ' ran. Updating database version and moving on.');
				await finalize();
			} else if (item === startVersion + '.sql') {
				log.info(logPrefix + 'Found sql migration script #' + startVersion + ', running it now.');

				const dbCon = await db.getConnection();

				await dbCon.query(fs.readFileSync(migrationScriptPath + '/' + items[i]).toString());

				log.info(logPrefix + 'Sql migration script #' + startVersion + ' ran. Updating database version and moving on.');

				dbCon.end();
				await finalize();
			}
		}
	}

	private async getLock() {
		const { tableName, log, lUtils, instanceLogPrefix } = this;
		const logPrefix = instanceLogPrefix + 'getLock() - tableName: "' + tableName + '" - ';
		const db = this.dbDriver;
		const dbCon = await db.getConnection();

		await dbCon.query('BEGIN');
		await dbCon.query('LOCK TABLE "' + tableName + '";');

		const { rows } = await dbCon.query('SELECT running FROM "' + tableName + '"');
		if (rows.length === 0) {
			await dbCon.query('COMMIT');
			dbCon.end();
			const err = new Error('No locking records exists, it should be created by now');
			log.error(logPrefix + err.message);
			throw err;
		} else if (rows[0].running !== 0) {
			await dbCon.query('COMMIT');
			await dbCon.end();
			log.info(logPrefix + 'Another process is running the migrations, wait and try again soon.');
			await lUtils.setTimeout(500);
			await this.getLock();
		} else {
			log.debug(logPrefix + 'Setting running to 1 in database table');
			await dbCon.query('UPDATE "' + tableName + '" SET running = 1');
			log.debug(logPrefix + 'Committing transaction');
			await dbCon.query('COMMIT');
			log.debug(logPrefix + 'Transaction commited, ending database connection');
			await dbCon.end();
		}
	}
}

export { DbMigration };
