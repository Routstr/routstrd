declare const self: Worker;
import { SessionsLoader } from "./sessions-data.ts";
const loader = new SessionsLoader();
self.onmessage = async (event: MessageEvent<number>) => {
  self.postMessage(await loader.load(event.data));
};
