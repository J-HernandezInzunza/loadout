declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}

interface ImportMetaEnv {
  readonly LOADOUT_GITHUB_CLIENT_ID?: string;
  readonly LOADOUT_BITBUCKET_CLIENT_ID?: string;
}
