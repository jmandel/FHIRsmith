export function params(parameter) {
  return { resourceType: 'Parameters', parameter };
}

export function getParam(body, name) {
  return (body?.parameter || []).find((param) => param.name === name);
}

export function propertyParts(parameters, code) {
  return (parameters || [])
    .filter((param) => param.name === 'property')
    .map((param) => param.part || [])
    .filter((parts) => parts.some((part) => part.name === 'code' && part.valueCode === code));
}

export function bundleLink(bundle, relation) {
  return (bundle?.link || []).find((link) => link.relation === relation);
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const SYS = {
  USPS: 'https://www.usps.com/',
};
