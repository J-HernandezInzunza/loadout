import { getVersion } from "@tauri-apps/api/app";
import { onMounted, ref } from "vue";

/**
 * The running build's version, so a bug report can say which build it is (R.01). Tauri reads it from
 * apps/desktop/package.json. null until it arrives, and stays null outside Tauri (a test without an IPC mock).
 */
export function useAppVersion() {
  const version = ref<string | null>(null);
  onMounted(async () => {
    version.value = await getVersion().catch(() => null);
  });
  return version;
}
