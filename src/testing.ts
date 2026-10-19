// Tools for testing what plugs into inkan, kept out of the main entry because they load
// node:test:
//
//   import { storeConformance } from "@vxnsin/inkan/testing";

export { storeConformance } from "./testing/store.ts";
export type { StoreConformanceOptions } from "./testing/store.ts";
