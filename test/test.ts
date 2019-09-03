import test from 'tape';
import dotenv from 'dotenv';
import { DbMigration } from '../src/index';
import { Log, Utils } from 'larvitutils';
import { Db } from 'larvitdb-pg';
import path from 'path';

dotenv.config();
const log = new Log();
const lUtils = new Utils({ log });
let db: Db;

test('Setup database connection', async t => {
	const dbConf = {
		log,
		host: process.env.DB_HOST,
		port: process.env.DB_PORT === undefined ? undefined : Number(process.env.DB_PORT),
		user: process.env.DB_USER || 'postgres',
		password: process.env.DB_PASSWORD,
		database: process.env.DB_DATABASE || 'test',
		connectionString: process.env.DB_CONNECTIONSTRING,
	};

	db = new Db(dbConf);

	if (process.env.CLEAR_DB === 'true') {
		await db.resetSchema('public');
	}

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


test('Should fail when migration returns error', async t => {
	await db.resetSchema('public');

	// Run failing migrations
	const dbMigrations = new DbMigration({
		migrationScriptPath: path.join(__dirname, '../testmigrations_failing'),
		dbDriver: db,
		log,
	});

	let thrownErr;

	try {
		await dbMigrations.run();
	} catch (err) {
		thrownErr = err;
	}

	t.equal(thrownErr instanceof Error, true, 'err should be an instance of Error');
	t.equal(thrownErr.message, 'some error');
	t.end();
});

test('Run multiple migrations at the same time', async t => {
	let migration1IsDone = false;
	let migration2IsDone = false;

	await db.resetSchema('public');

	const dbMigration1 = new DbMigration({
		migrationScriptPath: path.join(__dirname, '../testmigrations'),
		dbDriver: db,
		log,
	});

	const dbMigration2 = new DbMigration({
		migrationScriptPath: path.join(__dirname, '../testmigrations'),
		dbDriver: db,
		log,
	});

	const dbMigration3 = new DbMigration({
		migrationScriptPath: path.join(__dirname, '../testmigrations'),
		dbDriver: db,
		log,
	});

	// Run two of the migrations without awaiting
	dbMigration1.run().then(() => { migration1IsDone = true; });
	dbMigration2.run().then(() => { migration2IsDone = true; });

	// await the third migration that should finnish at some point
	await dbMigration3.run();

	// Make sure all migrations is done before proceeding, because
	// otherwise future SQL queries might be problematic
	while (migration1IsDone === false || migration2IsDone === false) {
		await lUtils.setTimeout(10);
	}

	// Check data
	const { rows } = await db.query('SELECT * FROM bloj');

	t.equal(rows.length, 1);
	t.equal(rows[0].hasse, 42);

	t.end();
});

test('Cleanup', async t => {
	await db.resetSchema('public');
	db.end();
	t.end();
});
