import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).use(createPinia()).mount("#app");

if (import.meta.env.VITE_SPIKE === "1") void import("./spike/run.ts").then((m) => m.runSpikes()).catch((e) => (document.title = `spike failed: ${e}`));
