'use strict';

const { SqliteV0FactoryProvider, openV0Database } = require('./cs-sqlite-v0');

class LoincSqliteV0FactoryProvider extends SqliteV0FactoryProvider {
  async buildKnownValueSet(url, vsVersion) {
    if (vsVersion && this._meta.version && vsVersion !== this._meta.version) {
      return null;
    }

    if (!url || !url.startsWith('http://loinc.org/vs')) {
      return await super.buildKnownValueSet(url, vsVersion);
    }

    if (url === 'http://loinc.org/vs') {
      return {
        resourceType: 'ValueSet',
        url,
        version: this.version(),
        status: 'active',
        name: 'LOINCValueSetAll',
        description: 'All LOINC codes',
        compose: {
          include: [{ system: this.system() }],
        },
      };
    }

    if (url.startsWith('http://loinc.org/vs/')) {
      const code = url.substring('http://loinc.org/vs/'.length);
      if (code) {
        const db = openV0Database(this._dbPath);
        try {
          const concept = db.prepare(`
            SELECT concept_id, display
              FROM concept
             WHERE cs_id = @cs
               AND code = @code
          `).get({ cs: this._meta.csId, code });
          if (concept) {
            const members = db.prepare(`
              SELECT tgt.code AS code
                FROM concept_link cl
                JOIN property_def pd
                  ON pd.property_id = cl.property_id
                 AND pd.property_code = 'Answer'
                JOIN concept tgt
                  ON tgt.concept_id = cl.target_concept_id
               WHERE cl.source_concept_id = @conceptId
                 AND cl.active = 1
               ORDER BY tgt.code
            `).all({ conceptId: concept.concept_id });
            if (members.length > 0) {
              return {
                resourceType: 'ValueSet',
                url,
                version: this.version(),
                status: 'active',
                name: `LOINCAnswerList${code.replace(/-/g, '_')}`,
                description: `LOINC Answer list for code ${code}: ${concept.display}`,
                compose: {
                  include: [{
                    system: this.system(),
                    concept: members.map(m => ({ code: m.code })),
                  }],
                },
              };
            }
          }
        } finally {
          db.close();
        }
      }
    }

    return await super.buildKnownValueSet(url, vsVersion);
  }
}

SqliteV0FactoryProvider.registerSpecialization({
  id: 'loinc-v0-implicit-valuesets',
  FactoryClass: LoincSqliteV0FactoryProvider,
  systemPrefix: 'http://loinc.org',
  priority: 50,
});

module.exports = {
  LoincSqliteV0FactoryProvider,
};
