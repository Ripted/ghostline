/// <reference types="vite/client" />

import type { NfApi } from "../preload";

declare global {
  interface Window {
    nf: NfApi;
  }
}

export {};