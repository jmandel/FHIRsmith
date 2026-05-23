// @ts-check

//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * VHL Processing Module
 *
 * This module handles the complex VHL (Verifiable Health Link) processing
 * when the vhl flag is set to true in an SHL entry.
 */

/**
 * Process VHL response for SHL entries with vhl=true
 *
 * @param {string} host - The host from the request (e.g., "localhost:3000")
 * @param {string} uuid - The SHL entry UUID
 * @param {{files: Array<{location: string, contentType: string}>}} standardResponse - The standard JSON response that would be returned
 * @returns {{resourceType: string, type: string, link: Array<{relation: string, url: string}>, entry: Array<Record<string, any>>}} The modified JSON response for VHL entries
 */
function processVHL(host, uuid, standardResponse) {
  // TODO: Implement your complex VHL processing logic here

  // Example structure - modify as needed:
  /** @type {{resourceType: string, type: string, link: Array<{relation: string, url: string}>, entry: Array<Record<string, any>>}} */
  const vhlResponse = {
    "resourceType": "Bundle",
    "type": "searchSet",
    "link": [{
      "relation": "self",
      "url": "https://" + host + "/shl/access/" + uuid
    }],
    "entry": []
  };

  for (const file of standardResponse.files) {
    const uuid2 = tail(file.location);
    const e = {
      "fullUrl": file.location,
      "resource": {
        "resourceType": "DocumentReference",
        "id": uuid2,
        "masterIdentifier": {
          "system": "urn:ietf:rfc:3986",
          "value": "urn:uuid:" + uuid2
        },
        "content": [{
          "url": file.location,
          "contentType": file.contentType
        }]
      }
    };
    vhlResponse.entry.push(e);
  }

  return vhlResponse;
}

/**
 * @param {string} url
 * @returns {string}
 */
function tail(url) {
  if (url.includes("/")) {
    return url.substring(url.lastIndexOf("/") + 1);
  } else {
    return url;
  }
}

module.exports = {
  processVHL
};
