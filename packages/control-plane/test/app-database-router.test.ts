import { describe, expect, it } from "vitest";
import {
  createAppDatabaseRouterFromBindings,
  createStaticAppDatabaseRouter,
  type D1DatabaseLike
} from "../src/index.js";

function database(label: string): D1DatabaseLike {
  return {
    prepare() {
      throw new Error(`database ${label} should not be queried by the router`);
    }
  };
}

describe("app database router", () => {
  it("resolves only the database explicitly assigned to the authenticated app", () => {
    const appOne = database("app-one");
    const appTwo = database("app-two");
    const router = createStaticAppDatabaseRouter([
      { appId: "app_1", database: appOne },
      { appId: "app_2", database: appTwo }
    ]);

    expect(router.resolve("app_1")).toBe(appOne);
    expect(router.resolve("app_2")).toBe(appTwo);
    expect(router.resolve("app_unknown")).toBeNull();
  });

  it("fails closed for duplicate, empty, or unsafe routing entries", () => {
    const db = database("invalid");

    expect(() =>
      createStaticAppDatabaseRouter([
        { appId: "app_1", database: db },
        { appId: "app_1", database: db }
      ])
    ).toThrow("duplicate app database route");
    expect(() => createStaticAppDatabaseRouter([{ appId: "", database: db }])).toThrow(
      "invalid app database route"
    );
    expect(() => createStaticAppDatabaseRouter([{ appId: "../app", database: db }])).toThrow(
      "invalid app database route"
    );
    expect(() =>
      createStaticAppDatabaseRouter([
        { appId: "app_1", database: db },
        { appId: "app_2", database: db }
      ])
    ).toThrow("app database binding must not be reused");
  });

  it("builds a fail-closed router from explicit Worker binding names", () => {
    const appOne = database("app-one");
    const appTwo = database("app-two");
    const router = createAppDatabaseRouterFromBindings({
      serializedRoutes: JSON.stringify({ app_1: "APP_1_DB", app_2: "APP_2_DB" }),
      bindings: { APP_1_DB: appOne, APP_2_DB: appTwo, UNRELATED_SECRET: "must-stay-private" }
    });

    expect(router.resolve("app_1")).toBe(appOne);
    expect(router.resolve("app_2")).toBe(appTwo);
    expect(router.resolve("app_3")).toBeNull();
  });

  it.each([
    ["[]", "app database routes must be a JSON object"],
    ['{"../app":"APP_DB"}', "invalid app database route"],
    ['{"app_1":"missing"}', "invalid app database binding name"],
    ['{"app_1":"APP_DB"}', "app database binding is unavailable"]
  ])("rejects unsafe Worker binding configuration %s", (serializedRoutes, message) => {
    expect(() => createAppDatabaseRouterFromBindings({ serializedRoutes, bindings: {} })).toThrow(
      message
    );
  });
});
