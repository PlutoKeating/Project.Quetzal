// 同源入口：页面由本机守护进程托管，握手与读写都只和它说话。
import { SeaClient } from "./api/client.js";
import { GovernanceApp } from "./app.js";

const root = document.getElementById("app");
if (root) {
  const app = new GovernanceApp(root, { api: new SeaClient() });
  void app.start();
}
