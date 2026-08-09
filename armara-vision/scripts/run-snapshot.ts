// Manual/system-cron entrypoint: `npm run snapshot`
import { runSnapshot } from "../src/lib/snapshot";

runSnapshot()
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.errors.length > 0 && r.assetsSnapshotted === 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
