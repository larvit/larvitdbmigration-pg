'use strict';

exports = module.exports = async options => {
	const { db } = options;

	await db.query('ALTER TABLE bloj RENAME nisse TO hasse');
	await db.query('INSERT INTO bloj (hasse) VALUES(42);');
};
