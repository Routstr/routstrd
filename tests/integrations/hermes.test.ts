import { describe, expect, it } from "bun:test";
import { parse } from "yaml";
import { mergeHermesConfig } from "../../src/integrations/hermes";

const ROUTSTR = {
  baseUrl: "http://localhost:8008/v1",
  apiKey: "routstr-key",
  defaultModel: "deepseek-v4-flash",
};

describe("mergeHermesConfig", () => {
  it("preserves the user's model and unrelated custom providers", () => {
    const existing = `model:
  default: user-model
  provider: custom
  base_url: https://user.example/v1
  api_key: user-key

custom_providers:
  - name: User Provider
    base_url: https://user.example/v1
    api_key: user-key
    model: user-model

other_setting: true
`;

    const merged = parse(mergeHermesConfig(existing, ROUTSTR));

    expect(merged.model).toEqual({
      default: "user-model",
      provider: "custom",
      base_url: "https://user.example/v1",
      api_key: "user-key",
    });
    expect(merged.other_setting).toBe(true);
    expect(merged.custom_providers).toContainEqual({
      name: "User Provider",
      base_url: "https://user.example/v1",
      api_key: "user-key",
      model: "user-model",
    });
    expect(merged.custom_providers).toContainEqual({
      name: "Routstr (localhost:8008)",
      base_url: ROUTSTR.baseUrl,
      api_key: ROUTSTR.apiKey,
      model: ROUTSTR.defaultModel,
    });
  });

  it("does not add a model configuration to an existing Hermes file", () => {
    const merged = parse(mergeHermesConfig("other_setting: true\n", ROUTSTR));

    expect(merged.model).toBeUndefined();
    expect(merged.other_setting).toBe(true);
  });

  it("creates a Routstr default when creating a new Hermes file", () => {
    const merged = parse(mergeHermesConfig("", ROUTSTR));

    expect(merged.model).toEqual({
      default: ROUTSTR.defaultModel,
      provider: "custom",
      base_url: ROUTSTR.baseUrl,
      api_key: ROUTSTR.apiKey,
    });
  });

  it("updates an existing Routstr provider in place without duplicating it", () => {
    const existing = `custom_providers:
  - name: Routstr (old-host:8008)
    base_url: http://old-host:8008/v1
    api_key: old-key
    model: old-model
`;

    const once = mergeHermesConfig(existing, ROUTSTR);
    const twice = mergeHermesConfig(once, ROUTSTR);
    const merged = parse(twice);
    const routstrProviders = merged.custom_providers.filter(
      (provider: { name?: string }) => provider.name?.startsWith("Routstr ("),
    );

    expect(routstrProviders).toHaveLength(1);
    expect(routstrProviders[0]).toEqual({
      name: "Routstr (localhost:8008)",
      base_url: ROUTSTR.baseUrl,
      api_key: ROUTSTR.apiKey,
      model: ROUTSTR.defaultModel,
    });
    expect(twice).toBe(once);
  });

  it("repoints model.provider when the Routstr provider is renamed", () => {
    const existing = `model:
  default: old-model
  provider: custom:routstr-(old-host:8008)

custom_providers:
  - name: Routstr (old-host:8008)
    base_url: http://old-host:8008/v1
    api_key: old-key
    model: old-model
`;

    const merged = parse(mergeHermesConfig(existing, ROUTSTR));

    expect(merged.model).toEqual({
      default: "old-model",
      provider: "custom:routstr-(localhost:8008)",
    });
  });

  it("leaves model.provider alone when it does not reference the Routstr provider", () => {
    const existing = `model:
  default: user-model
  provider: custom:user-provider

custom_providers:
  - name: Routstr (old-host:8008)
    base_url: http://old-host:8008/v1
    api_key: old-key
    model: old-model
`;

    const merged = parse(mergeHermesConfig(existing, ROUTSTR));

    expect(merged.model.provider).toBe("custom:user-provider");
  });

  it("rejects malformed YAML instead of replacing it", () => {
    expect(() => mergeHermesConfig("model: [unterminated", ROUTSTR)).toThrow();
  });
});
