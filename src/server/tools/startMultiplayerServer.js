require('../scripts/cleanup-dev-instance');

process.env.MULTIPLAYER_MODE = 'true';
process.env.ENABLE_POLICY_SERVER = 'true';

require('ts-node/register');
require('../main.ts');
