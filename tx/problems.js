// @ts-check

const escape = require('escape-html');

/** @typedef {import('../types/fhirsmith').FhirResource} FhirResource */
/** @typedef {{system?: string, version?: string, concept?: Array<{code?: string}>}} ValueSetInclude */
/** @typedef {{include?: ValueSetInclude[]}} ValueSetCompose */
/** @typedef {Record<string, Set<string>>} UnknownVersionMap */
/** @typedef {{jsonObj: FhirResource & {compose?: ValueSetCompose}}} ValueSetWrapper */
/**
 * @typedef {{
 *   sourcePackage(): string,
 *   listAllValueSets(): Promise<string[]>,
 *   fetchValueSet(url: string): Promise<ValueSetWrapper | null>
 * }} ValueSetProviderLike
 */
/**
 * @typedef {{
 *   valueSetProviders: ValueSetProviderLike[],
 *   listValueSetSourceCodes(): string[],
 *   hasCsVersion(system: string, version: string): Promise<boolean>,
 *   listCodeSystemVersions(system: string): Promise<Iterable<string>>
 * }} ProblemProviderLike
 */

class ProblemFinder {

  /**
   * @param {ProblemProviderLike} provider - Terminology provider to scan
   * @returns {Promise<string>} HTML table fragments describing unknown versions
   */
  async scanValueSets(provider) {
    /** @type {Record<string, UnknownVersionMap>} */
    let unknownVersions = {};  // system -> Set of versions not known to the server
    for (let vsp of provider.valueSetProviders) {
      let sourceUnknownVersions = unknownVersions[vsp.sourcePackage()];
      if (!sourceUnknownVersions) {
        sourceUnknownVersions = {};
        unknownVersions[vsp.sourcePackage()] = sourceUnknownVersions;
      }

      let list = await vsp.listAllValueSets();
      for (let url of list) {
        let vs = await vsp.fetchValueSet(url);
        if (vs && vs.jsonObj.compose) {
          await this.scanValueSet(vs.jsonObj.compose, sourceUnknownVersions);
        }
      }
    }
    let result = '';
    for (let sp of provider.listValueSetSourceCodes()) {
      let sourceUnknownVersions = unknownVersions[sp];
      if (sourceUnknownVersions) {
        // Filter to only versions the server doesn't know about
        for (const [system, vset] of Object.entries(sourceUnknownVersions)) {
          for (let v of [...vset]) {
            if (await provider.hasCsVersion(system, v)) {
              vset.delete(v);
            }
          }
          if (vset.size === 0) {
            delete sourceUnknownVersions[system];
          }
        }
        let list = await this.unknownVersionsHtml(sourceUnknownVersions, provider, sp);
        if (list) {
          result = result + `<h4>${sp}</h4>` + list;
        }
      }
    }
    return result;
  }

  /**
   * @param {UnknownVersionMap} unknownVersions - Unknown versions by system
   * @param {ProblemProviderLike} provider - Terminology provider
   * @param {string} source - Source package/code
   * @returns {Promise<string>} HTML table fragment
   */
  async unknownVersionsHtml(unknownVersions, provider, source) {
    const entries = Object.entries(unknownVersions || {});
    if (entries.length === 0) {
      return '<p>No unknown system versions found.</p>';
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    let html = '<table class="grid"><thead><tr><th>System</th><th>Unknown Versions</th><th>Known Versions</th></tr></thead><tbody>';
    for (const [system, vset] of entries) {
      const systemEsc = escape(system);
      const versions = [...vset].sort((a, b) => a.localeCompare(b));
      const versionRefs = [];
      for (const v of versions) {
        versionRefs.push(`<a href="ValueSet?system=${systemEsc}|${escape(v)}&source=${source}&_elements=url%2Cversion%2Cname%2Ctitle%2Cstatus%2Ccontent%2Cdate">${v}</a>`);
      }
      const knownVersions = [...await provider.listCodeSystemVersions(system)].join('<br/>');
      html += `<tr><td><a href="CodeSystem?url=${systemEsc}&_elements=url%2Cversion%2Cname%2Ctitle%2Cstatus%2Ccontent%2Cdate">${system}</a></td>`+
        `<td>${versionRefs.join('<br/>')}</td><td>${knownVersions}</td></tr>`;
    }
    html += '</tbody></table>';
    return html;
  }

  /**
   * @param {ValueSetCompose} compose - ValueSet compose block
   * @param {UnknownVersionMap} versions - Unknown versions by system
   * @returns {Promise<void>}
   */
  async scanValueSet(compose, versions) {
    for (let inc of compose.include || []) {
      if (inc.system && inc.version) {
        this.seeVersion(versions, inc.system, inc.version);
      }
    }
  }

  /**
   * @param {UnknownVersionMap} versions - Unknown versions by system
   * @param {string} system - CodeSystem canonical URL
   * @param {string} version - Referenced CodeSystem version
   * @returns {void}
   */
  seeVersion(versions, system, version) {
    let set = versions[system];
    if (set == null) {
      set = new Set();
      versions[system] = set;
    }
    set.add(version);
  }
}

module.exports = ProblemFinder;
