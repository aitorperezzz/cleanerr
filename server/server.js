import { createServer } from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";

const app = await createApp({ settingsFile: config.settingsFile });
const server = createServer(app);

server.listen(config.port, config.host, () => {
  console.log(`Cleanerr running at http://${config.host}:${config.port}`);
});
