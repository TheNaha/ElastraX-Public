import { runRetentionMaintenance } from '../src/db/maintenance';

const apply = process.argv.includes('--apply');
const result = runRetentionMaintenance({ dryRun: !apply });
console.log(JSON.stringify(result, null, 2));
