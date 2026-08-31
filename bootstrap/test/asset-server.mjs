// Serves one release asset and records how many times it was fetched. This runs
// out-of-process because the test driver uses spawnSync, which would block an
// in-process server's event loop and deadlock the download it is waiting on.

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [assetName, filePath, portFile, hitsFile] = process.argv.slice(2);
const payload = readFileSync(filePath);

let hits = 0;
const server = createServer((request, response) => {
  if (request.url === `/${assetName}`) {
    hits += 1;
    writeFileSync(hitsFile, String(hits));
    response.writeHead(200, { "content-length": payload.length }).end(payload);
  } else {
    response.writeHead(404).end("not found");
  }
});

writeFileSync(hitsFile, "0");
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
