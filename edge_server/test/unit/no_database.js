// =============================================================================
// Unit test guard. Require this FIRST in every unit test that loads server code
// able to run a database query (routes, controllers, services).
//
// Unit tests must work without MySQL and must never touch real data. Without
// this guard, server code loaded by a test reads edge_server/.env and would
// connect to the real database as soon as one request got past validation.
// The guard points the connection settings at a closed port and a database
// name that does not exist, so such a request fails instead.
// It is also loaded for every unit test file by the "test" script in package.json.
// =============================================================================
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '9';                 // nothing listens here
process.env.DB_NAME = 'shiro_unit_test';   // does not exist
process.env.INFLUX_TOKEN = '';             // time-series logging off

module.exports = { DB_PORT: 9, DB_NAME: 'shiro_unit_test' };
