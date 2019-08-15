import test from 'tape';
import dotenv from 'dotenv';
import { DbMigration } from '../src/index';
import { Log } from 'larvitutils';
import { Db } from 'larvitdb-pg';
import path from 'path';

dotenv.config();
const log = new Log();
let db: Db;

test('Setup database connection', async t => {
	const dbConf = {
		log,
		host: process.env.DB_HOST,
		port: process.env.DB_PORT === undefined ? undefined : Number(process.env.DB_PORT),
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
		database: process.env.DB_DATABASE || 'test',
		connectionString: process.env.DB_CONNECTIONSTRING,
	};

	db = new Db(dbConf);

	const res = await db.query('SELECT * FROM pg_catalog.pg_tables WHERE schemaname = \'public\';');

	if (res.rows.length !== 0) {
		const err = new Error('Database is not empty, please clean database before running tests');
		log.error(err.message);
		throw err;
	}

	t.end();
});

test('Run working migrations', async t => {
	const dbMigration = new DbMigration({
		migrationScriptPath: path.join(__dirname, '../testmigrations'),
		dbDriver: db,
		log,
	});

	await dbMigration.run();

	t.end();
});

test('Should fetch some data form a migrated table', async t => {
	const { rows } = await db.query('SELECT * FROM bloj');

	t.equal(rows.length, 1);
	t.equal(rows[0].hasse, 42);

	t.end();
});

test('Run migrations again and check bloj', async t => {
	const dbMigration = new DbMigration({
		migrationScriptPath: path.join(__dirname, '../testmigrations'),
		dbDriver: db,
		log,
	});

	await dbMigration.run();

	const { rows } = await db.query('SELECT * FROM bloj');

	t.equal(rows.length, 1);
	t.equal(rows[0].hasse, 42);

	t.end();
});

test('Check db_version', async t => {
	const { rows } = await db.query('SELECT * FROM db_version');

	t.equal(rows.length, 1, 'There should only be one row in db_version');
	t.equal(rows[0].id, 1, 'The id of the db_version should always be 1');
	t.equal(rows[0].running, 0, 'Running state of the db_version should be 0');
	t.equal(rows[0].version, 2, 'Version should be set to 2');

	t.end();
});


/* Do me!
test('Should fail when migration returns error', async () => {
	await db.removeAllTables();

	// Run failing migrations
	const dbMigrations = new DbMigration({
		migrationScriptPath: path.join(__dirname, '../testmigrations_mariadb_failing'),
		dbType: 'mariadb',
		dbDriver: db,
		log
	});

	let thrownErr;

	try {
		await dbMigrations.run();
	} catch (err) {
		thrownErr = err;
	}

	assert(thrownErr instanceof Error, 'err should be an instance of Error');
	assert.strictEqual(thrownErr.message, 'some error');
});
*/

test('Cleanup', async t => {
	let sql = '';
	sql += 'DROP SCHEMA public CASCADE;';
	sql += 'CREATE SCHEMA public;';
	sql += 'GRANT ALL ON SCHEMA public TO public;';
	sql += 'COMMENT ON SCHEMA public IS \'standard public schema\';';
	await db.query(sql);
	db.end();
	t.end();
});
