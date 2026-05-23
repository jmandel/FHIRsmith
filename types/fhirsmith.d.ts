export type FhirPrimitive = string | number | boolean | null | undefined;

export interface FhirElement {
  extension?: FhirExtension[];
  modifierExtension?: FhirExtension[];
  implicitRules?: string;
  jsonObj?: FhirElement;
  [key: string]: any;
}

export interface FhirExtension extends FhirElement {
  url: string;
}

export interface FhirResource extends FhirElement {
  resourceType?: string;
  id?: string;
  url?: string;
  version?: string;
  language?: string;
  parameter?: FhirParameterPart[];
}

export interface FhirParameterPart extends FhirElement {
  name: string;
  part?: FhirParameterPart[];
  resource?: FhirResource;
  valueString?: string;
  valueCode?: string;
  valueDateTime?: string;
}

export type FhirExtensionSource = FhirElement | FhirExtension[] | null | undefined;

export interface FhirCoding extends FhirElement {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept extends FhirElement {
  text?: string;
  coding?: FhirCoding[];
}

export interface FhirOperationOutcomeIssue extends FhirElement {
  severity: string;
  code: string;
  details: FhirCodeableConcept;
  expression?: string[];
  diagnostics?: string;
}

export interface FhirOperationOutcome extends FhirResource {
  resourceType: 'OperationOutcome';
  issue?: FhirOperationOutcomeIssue[];
}

export interface FhirNamingSystemUniqueId extends FhirElement {
  type: string;
  value: string;
  preferred?: boolean;
}

export interface FhirNamingSystem extends FhirResource {
  resourceType: 'NamingSystem';
  name: string;
  status: string;
  kind: string;
  uniqueId: FhirNamingSystemUniqueId[];
  title?: string;
  usage?: string;
}

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
}

export interface XmlAttribute {
  name: string;
  value: string;
}
