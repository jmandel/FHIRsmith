// @ts-check

const path = require("path");
const fs = require("fs");
const { getProperties } = require("properties-file");
const {validateParameter} = require("./utilities");
const {LanguageDefinitions} = require("./languages");

/**
 * @typedef {import('./languages').Languages} Languages
 * @typedef {Record<string, string>} MessageBundle
 */

/**
 * Internationalization support for loading Java properties files
 */
class I18nSupport {
  /** @type {string} */
  translationsPath;
  /** @type {LanguageDefinitions} */
  languageDefinitions;
  /** @type {Map<string, MessageBundle>} */
  bundles;
  /** @type {Map<string, MessageBundle>} */
  phrases;

  /**
   * @param {string} translationsPath
   * @param {LanguageDefinitions} languageDefinitions
   */
  constructor(translationsPath, languageDefinitions) {
    validateParameter(translationsPath, "translationsPath", String);
    validateParameter(languageDefinitions, "languageDefinitions", LanguageDefinitions);
    this.translationsPath = translationsPath;
    this.languageDefinitions = languageDefinitions;
    this.bundles = new Map(); // Cache for loaded message bundles by language code
    this.phrases = new Map(); // Cache for loaded message bundles by language code
  }

  /**
   * Load all available message bundles from the translations directory
   */
  async load() {
    await this._loadResourceBundle(this.bundles, 'Messages');
    await this._loadResourceBundle(this.phrases, 'rendering-phrases');
  }

  /**
   * @param {Map<string, MessageBundle>} bundles
   * @param {string} name
   * @returns {Promise<void>}
   */
  async _loadResourceBundle(bundles, name) {
    // Load default Messages.properties first
    await this._loadBundle(bundles, 'en', name+'.properties');

    // Scan for Messages_*.properties files
    try {
      const files = fs.readdirSync(this.translationsPath);
      const messageFiles = files.filter(file =>
        file.startsWith(name+'_') && file.endsWith('.properties')
      );

      for (const file of messageFiles) {
        // Extract language code from filename: Messages_fr_FR.properties -> fr-FR
        const langCode = file
          .substring((name+'_').length, file.length - '.properties'.length)
          .replace(/_/g, '-');

        await this._loadBundle(bundles, langCode, file);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to scan translations directory: ${message}`);
    }
  }

  /**
   * Load a specific message bundle file
   * @param {Map<string, MessageBundle>} bundles
   * @param {string} langCode
   * @param {string} filename
   * @returns {Promise<void>}
   */
  async _loadBundle(bundles, langCode, filename) {
    try {
      const filePath = path.join(this.translationsPath, filename);
      const content = fs.readFileSync(filePath, 'utf8');
      const properties = getProperties(content);

      bundles.set(langCode, properties);
    } catch (error) {
      // Don't throw for missing files - just skip them
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: Could not load ${filename}: ${message}`);
    }
  }

  /**
   * Format a message with parameter substitution
   * @param {string} messageId - Message key from properties file
   * @param {Languages} languages - Languages object with preference order
   * @param {string[]} parameters - Parameters for {0}, {1}, etc. substitution
   * @returns {string} Formatted message
   */
  formatMessage(languages, messageId, parameters = []) {
    return this._formatMessageFromBundle(this.bundles, languages, messageId, parameters);
  }

  /**
   * @param {string} messageId
   * @param {Languages} languages
   * @param {string[]} [parameters]
   * @returns {string}
   */
  translate(messageId, languages, parameters = []) {
    return this.formatMessage(languages, messageId, parameters);
  }

  /**
   * @param {number} count
   * @param {string} messageId
   * @param {Languages} languages
   * @param {string[]} [parameters]
   * @returns {string}
   */
  translatePlural(count, messageId, languages, parameters = []) {
    return this.formatMessagePlural(languages, messageId, count, parameters);
  }

  /**
   * Format a message with pluralization support
   * @param {string} messageId - Base message key from properties file
   * @param {Languages} languages - Languages object with preference order
   * @param {number} count - Count for pluralization (becomes {0} in final message)
   * @param {string[]} parameters - Additional parameters for {1}, {2}, etc. substitution
   * @returns {string} Formatted message
   */
  formatMessagePlural(languages, messageId, count, parameters = []) {
    return this._formatMessagePluralFromBundle(this.bundles, languages, messageId, count, parameters);
  }

  /**
   * Format a message with parameter substitution
   * @param {string} messageId - Message key from properties file
   * @param {Languages} languages - Languages object with preference order
   * @param {string[]} parameters - Parameters for {0}, {1}, etc. substitution
   * @returns {string} Formatted message
   */
  formatPhrase(messageId, languages, parameters = []) {
    return this._formatMessageFromBundle(this.phrases, languages, messageId, parameters);
  }

  /**
   * @param {string} messageId
   * @param {Languages} languages
   * @param {string[]} [parameters]
   * @returns {string}
   */
  translatePhrase(messageId, languages, parameters = []) {
    return this.formatPhrase(messageId, languages, parameters);
  }

  /**
   * @param {number} count
   * @param {string} messageId
   * @param {Languages} languages
   * @param {string[]} [parameters]
   * @returns {string}
   */
  translatePhrasePlural(count, messageId, languages, parameters = []) {
    return this.formatPhrasePlural(messageId, languages, count, parameters);
  }

  /**
   * Format a message with pluralization support
   * @param {string} messageId - Base message key from properties file
   * @param {Languages} languages - Languages object with preference order
   * @param {number} count - Count for pluralization (becomes {0} in final message)
   * @param {string[]} parameters - Additional parameters for {1}, {2}, etc. substitution
   * @returns {string} Formatted message
   */
  formatPhrasePlural(messageId, languages, count, parameters = []) {
    return this._formatMessagePluralFromBundle(this.phrases, languages, messageId, count, parameters);
  }

  /**
   * @param {Map<string, MessageBundle>} bundles
   * @param {Languages} languages
   * @param {string} messageId
   * @param {string[]} [parameters]
   * @returns {string}
   */
  _formatMessageFromBundle(bundles, languages, messageId, parameters = []) {
    // Find the best language bundle that has this message
    const message = this._findMessage(bundles, languages, messageId);

    if (!message) {
      return messageId; // Fallback to message ID if not found
    }

    // Substitute parameters {0}, {1}, etc.
    return this._substituteParameters(message.trim(), parameters).replaceAll("''", "'");
  }

  /**
   * @param {Map<string, MessageBundle>} bundles
   * @param {Languages} languages
   * @param {string} messageId
   * @param {number} count
   * @param {string[]} [parameters]
   * @returns {string}
   */
  _formatMessagePluralFromBundle(bundles, languages, messageId, count, parameters = []) {
    // Determine plural form suffix
    const pluralSuffix = count === 1 ? '_one' : '_other';
    const pluralMessageId = messageId + pluralSuffix;

    // Try to find the plural-specific message first
    let message = this._findMessage(bundles, languages, pluralMessageId);

    // If not found, fall back to the base message
    if (!message) {
      message = this._findMessage(bundles, languages, messageId);
    }

    if (!message) {
      return messageId; // Fallback to message ID if not found
    }

    // Prepend count as parameter 0, shift other parameters
    const allParameters = [count.toString(), ...parameters];

    // Substitute parameters {0}, {1}, etc.
    return this._substituteParameters(message, allParameters).replaceAll("''", "'");
  }

  /**
   * Find message in language bundles with fallback logic
   * @param {Map<string, MessageBundle>} bundles
   * @param {Languages | null | undefined} languages
   * @param {string} messageId
   * @returns {string | null}
   */
  _findMessage(bundles, languages, messageId) {
    // Try each language in preference order
    if (languages) {
      for (const language of languages) {
        const message = this._getMessageForLanguage(bundles, language.code, messageId);
        if (message) {
          return message;
        }

        // Try language without region (e.g., 'fr' for 'fr-FR')
        if (language.language && language.language !== language.code) {
          const message = this._getMessageForLanguage(bundles, language.language, messageId);
          if (message) {
            return message;
          }
        }
      }
    }

    // Final fallback to English
    return this._getMessageForLanguage(bundles,'en', messageId);
  }

  /**
   * Get message for specific language code
   * @param {Map<string, MessageBundle>} bundles
   * @param {string} langCode
   * @param {string} messageId
   * @returns {string | null}
   */
  _getMessageForLanguage(bundles, langCode, messageId) {
    const bundle = bundles.get(langCode);
    return bundle ? bundle[messageId] : null;
  }

  /**
   * Substitute parameters in message string
   * Replaces {0}, {1}, etc. with provided parameters
   * @param {string} message
   * @param {string[]} parameters
   * @returns {string}
   */
  _substituteParameters(message, parameters) {
    if (!parameters || parameters.length === 0) {
      return message;
    }

    return message.replace(/\{(\d+)\}/g, (match, index) => {
      const paramIndex = parseInt(index);
      return paramIndex < parameters.length ? parameters[paramIndex] : match;
    });
  }

  /**
   * Get all available language codes
   * @returns {string[]}
   */
  getAvailableLanguages() {
    return Array.from(this.bundles.keys());
  }

  /**
   * Check if a message exists for any language
   * @param {string} messageId
   * @returns {boolean}
   */
  hasMessage(messageId) {
    for (const bundle of this.bundles.values()) {
      if (bundle[messageId]) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a message exists for any language
   * @param {string} messageId
   * @returns {boolean}
   */
  hasPhrase(messageId) {
    for (const bundle of this.phrases.values()) {
      if (bundle[messageId]) {
        return true;
      }
    }
    return false;
  }

  /**
   * Create a linked copy of this I18nSupport instance
   * @returns {I18nSupport}
   */
  link() {
    const copy = new I18nSupport(this.translationsPath, this.languageDefinitions);
    copy.bundles = new Map(this.bundles); // Shallow copy of bundles map
    copy.phrases = new Map(this.phrases); // Shallow copy of bundles map
    return copy;
  }
}

module.exports = {
  I18nSupport
};
