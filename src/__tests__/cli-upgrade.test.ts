import { describe, it, expect } from 'vitest';
import { buildUpgradeArgs } from '../cli.js';

describe('buildUpgradeArgs', () => {
  it('builds npm args for an explicit version', () => {
    expect(buildUpgradeArgs('1.2.3')).toEqual([
      'install',
      '-g',
      '@mininglamp-oss/cc-channel-octo@1.2.3',
    ]);
  });

  it('falls back to @latest when no version is given', () => {
    expect(buildUpgradeArgs()).toEqual([
      'install',
      '-g',
      '@mininglamp-oss/cc-channel-octo@latest',
    ]);
  });

  it('treats blank/whitespace version as latest', () => {
    expect(buildUpgradeArgs('   ')).toEqual([
      'install',
      '-g',
      '@mininglamp-oss/cc-channel-octo@latest',
    ]);
  });

  it('accepts a prerelease/build-metadata semver', () => {
    expect(buildUpgradeArgs('1.2.3-rc.1+build5')).toEqual([
      'install',
      '-g',
      '@mininglamp-oss/cc-channel-octo@1.2.3-rc.1+build5',
    ]);
  });

  it('rejects a version with shell metacharacters (injection guard)', () => {
    expect(() => buildUpgradeArgs('1.2.3; rm -rf /')).toThrow();
    expect(() => buildUpgradeArgs('$(whoami)')).toThrow();
    expect(() => buildUpgradeArgs('1.2.3 && curl evil')).toThrow();
  });
});
