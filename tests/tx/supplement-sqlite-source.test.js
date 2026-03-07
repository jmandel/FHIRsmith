'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDiceSupplementBundle } = require('../../tx/supplements/synthetic');
const { writeSupplementSidecar } = require('../../tx/supplements/sqlite-sidecar');
const {
  addSqliteSidecars,
  buildSupplementRegistry,
  createSupplementRegistry,
} = require('../../tx/supplements/registry');
const {
  materializeSupplementItemOverlaySource,
  materializeSupplementSetOverlaySources,
  resolveSupplementsForBaseScope,
} = require('../../tx/supplements/resolver');
const { makeSupplementRef } = require('../../tx/supplements/types');

function makeSidecar() {
  const base = {
    system: 'http://example.org/base',
    version: '1',
    name: 'Example Base',
    codes: [{ code: 'A' }, { code: 'B' }],
  };
  const resource = buildDiceSupplementBundle(base, {
    dice: ['d20'],
    urlRoot: 'http://example.org/fhir/CodeSystem/test-dice',
    version: '1',
    salt: 'sqlite-source',
  })[0].resource;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supp-sqlite-src-'));
  const dbPath = path.join(dir, 'd20.supp.db');
  writeSupplementSidecar(dbPath, resource);
  return { dir, dbPath, resource };
}

describe('sqlite supplement source registry', () => {
  test('resolves sqlite sidecar as native binding source', async () => {
    const { dir, dbPath, resource } = makeSidecar();
    try {
      const registry = createSupplementRegistry();
      addSqliteSidecars(registry, [dbPath]);
      const result = await resolveSupplementsForBaseScope({
        target: { system: 'http://example.org/base', version: '1' },
        refs: [makeSupplementRef(resource.url, 'useSupplement', 0)],
        registry,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].descriptor.sourceKind).toBe('sqlite-native');
      expect(result.items[0].overlaySource).toBeNull();
      expect(result.items[0].nativeBindingSource).toEqual(expect.objectContaining({
        kind: 'sqlite-sidecar',
        dbPath,
      }));
      await materializeSupplementSetOverlaySources(result);
      expect(result.items[0].overlaySource).toEqual(expect.any(Object));
      expect(result.items[0].overlaySource.url).toBe(resource.url);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps sqlite sidecar overlay materialization lazy until explicitly requested', async () => {
    const { dir, resource } = makeSidecar();
    try {
      const materializeCodeSystem = jest.fn(async () => resource);
      const materializeNativeBinding = jest.fn(async () => ({
        kind: 'sqlite-sidecar',
        dbPath: '/tmp/fake-supp.db',
      }));
      const registry = {
        entries: [{
          descriptor: {
            canonical: resource.version ? `${resource.url}|${resource.version}` : resource.url,
            url: resource.url,
            version: resource.version || null,
            versionAlgorithm: null,
            targetSystem: 'http://example.org/base',
            targetVersion: '1',
            sourceKind: 'sqlite-native',
            displayName: resource.title || resource.name || null,
          },
          precedence: 30,
          materializeCodeSystem,
          materializeNativeBinding,
        }],
      };

      const result = await resolveSupplementsForBaseScope({
        target: { system: 'http://example.org/base', version: '1' },
        refs: [makeSupplementRef(resource.url, 'useSupplement', 0)],
        registry,
      });

      expect(result.items).toHaveLength(1);
      expect(materializeNativeBinding).toHaveBeenCalledTimes(1);
      expect(materializeCodeSystem).not.toHaveBeenCalled();
      expect(result.items[0].overlaySource).toBeNull();

      await materializeSupplementItemOverlaySource(result.items[0]);
      expect(materializeCodeSystem).toHaveBeenCalledTimes(1);
      expect(result.items[0].overlaySource?.url).toBe(resource.url);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('buildSupplementRegistry picks up factory sqlite supplements', async () => {
    const { dir, dbPath, resource } = makeSidecar();
    try {
      const factory = {
        registerSqliteSupplements: jest.fn(async () => [{ dbPath }]),
      };
      const registry = await buildSupplementRegistry({ providerFactories: [factory] });
      const result = await resolveSupplementsForBaseScope({
        target: { system: 'http://example.org/base', version: '1' },
        refs: [makeSupplementRef(resource.url, 'useSupplement', 0)],
        registry,
      });

      expect(factory.registerSqliteSupplements).toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].nativeBindingSource).toEqual(expect.objectContaining({
        kind: 'sqlite-sidecar',
        dbPath,
      }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
