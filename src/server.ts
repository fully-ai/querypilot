import { createQueryPilotApp } from "./app.js";

const host = process.env.QUERYPILOT_HOST ?? "127.0.0.1";
const port = Number(process.env.QUERYPILOT_PORT ?? 8092);

const { app } = createQueryPilotApp();
app.listen(port, host, () => {
  console.log(`QueryPilot listening on http://${host}:${port}`);
});
