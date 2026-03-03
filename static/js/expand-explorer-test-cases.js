'use strict';

// Shared explorer test cases for expand-explorer and compile-to-ir.
(function (g) {
  g.EXPAND_EXPLORER_TEST_CASES = [
  // --- SQL Pushdown Core ---
  {name:"SNOMED is-a deep page",category:"SQL Pushdown Core",description:"Large hierarchy expansion with deep paging (pushdown windowing).",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"123037004"}]}]}},
   params:{count:1000,offset:40000}},
  {name:"SNOMED complex include/exclude",category:"SQL Pushdown Core",description:"Same-provider union minus union over SNOMED hierarchies.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"64572001"}]},{system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"123037004"}]}],exclude:[{system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"73211009"}]},{system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"442083009"}]}]}},
   params:{count:500}},
  {name:"SNOMED complex count-only",category:"SQL Pushdown Core",description:"Count-only fast path for same complex SNOMED expression (returns total with empty contains by design).",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"64572001"}]},{system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"123037004"}]}],exclude:[{system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"73211009"}]},{system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"442083009"}]}]}},
   params:{count:0}},
  {name:"LOINC STATUS=ACTIVE deep page",category:"SQL Pushdown Core",description:"Large non-hierarchy property filter in LOINC with deep offset.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://loinc.org",filter:[{property:"STATUS",op:"=",value:"ACTIVE"}]}]}},
   params:{count:1000,offset:20000}},
  {name:"RxNorm TTY=SBD",category:"SQL Pushdown Core",description:"RxNorm property filter using TTY semantic class.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://www.nlm.nih.gov/research/umls/rxnorm",filter:[{property:"TTY",op:"=",value:"SBD"}]}]}},
   params:{count:1000}},
  {name:"SNOMED code regex 7.*",category:"SQL Pushdown Core",description:"Regex filter over code domain.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://snomed.info/sct",filter:[{property:"code",op:"regex",value:"7.*"}]}]}},
   params:{count:20}},
  {name:"LOINC supplement d20 filter",category:"SQL Pushdown Core",description:"Supplement-aware native property filter (d20=1).",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://loinc.org",filter:[{property:"d20",op:"=",value:"1"}]}]}},
   params:{count:1000,useSupplement:["http://example.org/fhir/CodeSystem/supplement-loinc-d20"],property:["d20"]}},
  {name:"LOINC supplement d20+d8 filter",category:"SQL Pushdown Core",description:"Two supplement predicates in one include clause.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://loinc.org",filter:[{property:"d20",op:"=",value:"20"},{property:"d8",op:"=",value:"8"}]}]}},
   params:{count:500,useSupplement:["http://example.org/fhir/CodeSystem/supplement-loinc-d20","http://example.org/fhir/CodeSystem/supplement-loinc-d8"],property:["d20","d8"]}},
  {name:"LOINC supplement decoration-only",category:"SQL Pushdown Core",description:"Attach supplement properties/designations without supplement filtering.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"2160-0"},{code:"4548-4"},{code:"718-7"}]}]}},
   params:{useSupplement:["http://example.org/fhir/CodeSystem/supplement-loinc-d20","http://example.org/fhir/CodeSystem/supplement-loinc-d8"],property:["d20","d8"],includeDesignations:true}},
  {name:"RxNorm filter + supplement decoration",category:"SQL Pushdown Core",description:"Base-system filter plus supplement overlays in one request.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://www.nlm.nih.gov/research/umls/rxnorm",filter:[{property:"TTY",op:"=",value:"SBD"}]}]}},
   params:{count:200,useSupplement:["http://example.org/fhir/CodeSystem/supplement-rxnorm-d20"],property:["d20"],includeDesignations:true}},

  // --- IR Rewriting & Lowering ---
  {name:"Import+filter intersection lowering",category:"IR Rewriting & Lowering",description:"Import-only LOINC ValueSet intersected with local LOINC filter.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://loinc.org",filter:[{property:"STATUS",op:"=",value:"ACTIVE"}],valueSet:["http://example.org/vs/loinc-core"]}]}},
   txResources:[{resourceType:"ValueSet",url:"http://example.org/vs/loinc-core",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"2160-0"},{code:"4548-4"},{code:"718-7"}]}]}}],
   params:{count:100}},
  {name:"Import exclude lowering",category:"IR Rewriting & Lowering",description:"Top-level LOINC include minus imported LOINC subset.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://loinc.org",filter:[{property:"STATUS",op:"=",value:"ACTIVE"}]}],exclude:[{valueSet:["http://example.org/vs/loinc-unlucky"]}]}},
   txResources:[{resourceType:"ValueSet",url:"http://example.org/vs/loinc-unlucky",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"2160-0"},{code:"4548-4"},{code:"718-7"}]}]}}],
   params:{count:200}},
  {name:"Deep import include graph",category:"IR Rewriting & Lowering",description:"Top-level include imports a ValueSet that itself imports two ValueSets; resolved IR should flatten and reconcile all include paths.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{valueSet:["http://example.org/vs/loinc-root-include"]}]}},
   txResources:[
     {resourceType:"ValueSet",url:"http://example.org/vs/loinc-root-include",status:"active",compose:{include:[{valueSet:["http://example.org/vs/loinc-branch-a"]},{valueSet:["http://example.org/vs/loinc-branch-b"]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/loinc-branch-a",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"2160-0"},{code:"4548-4"}]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/loinc-branch-b",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"718-7"},{code:"2951-2"}]}]}}
   ],
   params:{}},
  {name:"Deep import include minus exclude graph",category:"IR Rewriting & Lowering",description:"Top-level include and exclude both import nested ValueSets; resolved IR should reconcile deep union/diff boundaries.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{valueSet:["http://example.org/vs/loinc-root-include-2"]}],exclude:[{valueSet:["http://example.org/vs/loinc-root-exclude-2"]}]}},
   txResources:[
     {resourceType:"ValueSet",url:"http://example.org/vs/loinc-root-include-2",status:"active",compose:{include:[{valueSet:["http://example.org/vs/loinc-inc-a"]},{valueSet:["http://example.org/vs/loinc-inc-b"]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/loinc-inc-a",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"2160-0"},{code:"4548-4"}]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/loinc-inc-b",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"718-7"},{code:"2951-2"}]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/loinc-root-exclude-2",status:"active",compose:{include:[{valueSet:["http://example.org/vs/loinc-exc-a"]},{valueSet:["http://example.org/vs/loinc-exc-b"]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/loinc-exc-a",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"4548-4"}]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/loinc-exc-b",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"2951-2"}]}]}}
   ],
   params:{}},
  {name:"Deep mixed import graph (SNOMED+LOINC)",category:"IR Rewriting & Lowering",description:"Nested import tree brings both SNOMED and LOINC branches; engine should partition execution by system/provider.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{valueSet:["http://example.org/vs/mixed-root-include"]}]}},
   txResources:[
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-root-include",status:"active",compose:{include:[{valueSet:["http://example.org/vs/mixed-branch-a"]},{valueSet:["http://example.org/vs/mixed-branch-b"]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-branch-a",status:"active",compose:{include:[{valueSet:["http://example.org/vs/mixed-snomed-leaf"]},{valueSet:["http://example.org/vs/mixed-loinc-leaf"]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-branch-b",status:"active",compose:{include:[{system:"http://snomed.info/sct",concept:[{code:"46635009"}]},{system:"http://loinc.org",concept:[{code:"2951-2"}]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-snomed-leaf",status:"active",compose:{include:[{system:"http://snomed.info/sct",concept:[{code:"73211009"},{code:"44054006"}]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-loinc-leaf",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"2160-0"},{code:"4548-4"}]}]}}
   ],
   params:{}},
  {name:"Deep mixed include-minus-exclude (SNOMED+LOINC)",category:"IR Rewriting & Lowering",description:"Nested include and exclude import trees each span SNOMED+LOINC; resolved IR should reconcile deep cross-system diff safely.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{valueSet:["http://example.org/vs/mixed-root-include-2"]}],exclude:[{valueSet:["http://example.org/vs/mixed-root-exclude-2"]}]}},
   txResources:[
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-root-include-2",status:"active",compose:{include:[{valueSet:["http://example.org/vs/mixed-inc-a"]},{valueSet:["http://example.org/vs/mixed-inc-b"]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-inc-a",status:"active",compose:{include:[{system:"http://snomed.info/sct",concept:[{code:"73211009"},{code:"44054006"}]},{system:"http://loinc.org",concept:[{code:"2160-0"},{code:"4548-4"}]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-inc-b",status:"active",compose:{include:[{system:"http://snomed.info/sct",concept:[{code:"46635009"}]},{system:"http://loinc.org",concept:[{code:"718-7"}]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-root-exclude-2",status:"active",compose:{include:[{valueSet:["http://example.org/vs/mixed-exc-a"]},{valueSet:["http://example.org/vs/mixed-exc-b"]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-exc-a",status:"active",compose:{include:[{system:"http://snomed.info/sct",concept:[{code:"44054006"}]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-exc-b",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"4548-4"}]}]}}
   ],
   params:{}},
  {name:"Deep mixed filters+codes include/exclude (SNOMED+LOINC)",category:"IR Rewriting & Lowering",description:"Deep nested imports where both include and exclude sides mix filter and concept components across SNOMED+LOINC.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{valueSet:["http://example.org/vs/mixed-filter-code-root-inc"]}],exclude:[{valueSet:["http://example.org/vs/mixed-filter-code-root-exc"]}]}},
   txResources:[
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-filter-code-root-inc",status:"active",compose:{include:[{valueSet:["http://example.org/vs/mixed-filter-code-inc-a"]},{valueSet:["http://example.org/vs/mixed-filter-code-inc-b"]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-filter-code-inc-a",status:"active",compose:{include:[
       {system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"73211009"}]},
       {system:"http://snomed.info/sct",concept:[{code:"44054006"}]},
       {system:"http://loinc.org",filter:[{property:"STATUS",op:"=",value:"ACTIVE"}]},
       {system:"http://loinc.org",concept:[{code:"2160-0"},{code:"4548-4"}]}
     ]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-filter-code-inc-b",status:"active",compose:{include:[
       {system:"http://snomed.info/sct",concept:[{code:"46635009"}]},
       {system:"http://loinc.org",concept:[{code:"718-7"}]}
     ]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-filter-code-root-exc",status:"active",compose:{include:[{valueSet:["http://example.org/vs/mixed-filter-code-exc-a"]},{valueSet:["http://example.org/vs/mixed-filter-code-exc-b"]}]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-filter-code-exc-a",status:"active",compose:{include:[
       {system:"http://snomed.info/sct",filter:[{property:"concept",op:"is-a",value:"46635009"}]},
       {system:"http://snomed.info/sct",concept:[{code:"44054006"}]}
     ]}},
     {resourceType:"ValueSet",url:"http://example.org/vs/mixed-filter-code-exc-b",status:"active",compose:{include:[
       {system:"http://loinc.org",filter:[{property:"STATUS",op:"=",value:"ACTIVE"}]},
       {system:"http://loinc.org",concept:[{code:"4548-4"}]}
     ]}}
   ],
   params:{count:200}},
  {name:"Union merge lowering",category:"IR Rewriting & Lowering",description:"Two same-system concept includes should collapse into one merged selector.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"2160-0"},{code:"4548-4"}]},{system:"http://loinc.org",concept:[{code:"718-7"},{code:"2951-2"}]}]}},
   params:{}},
  {name:"Provider-disjoint exclude pruning",category:"IR Rewriting & Lowering",description:"USPS exclude is disjoint from LOINC include and should not constrain LOINC pushdown.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://loinc.org",filter:[{property:"STATUS",op:"=",value:"ACTIVE"}]}],exclude:[{system:"https://www.usps.com/",concept:[{code:"CA"},{code:"NY"}]}]}},
   params:{count:200}},

  // --- Hybrid Execution (v0 + legacy/base) ---
  {name:"LOINC + USPS mixed providers",category:"Hybrid Execution (v0 + legacy/base)",description:"Query-target sqlite slice alongside internal legacy/base provider slice.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://loinc.org",filter:[{property:"STATUS",op:"=",value:"ACTIVE"}]},{system:"https://www.usps.com/"}]}},
   params:{count:200}},
  {name:"Cross-provider excludes",category:"Hybrid Execution (v0 + legacy/base)",description:"Global exclude semantics across sqlite and non-sqlite systems.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://loinc.org",concept:[{code:"2160-0"},{code:"4548-4"}]},{system:"http://hl7.org/fhir/administrative-gender"}],exclude:[{system:"http://loinc.org",concept:[{code:"4548-4"}]},{system:"http://hl7.org/fhir/administrative-gender",concept:[{code:"unknown"}]}]}},
   params:{}},
  {name:"UCUM base-only path",category:"Hybrid Execution (v0 + legacy/base)",description:"Grammar-backed UCUM expansion path (non-query-target provider).",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{system:"http://unitsofmeasure.org"}]}},
   params:{count:20}},
  {name:"TX-resource import + sqlite peer",category:"Hybrid Execution (v0 + legacy/base)",description:"Inline imported ValueSet branch plus sqlite LOINC branch in one request.",
   valueSet:{resourceType:"ValueSet",status:"active",compose:{include:[{valueSet:["http://example.org/vs/warm-colors"]},{system:"http://loinc.org",concept:[{code:"2160-0"}]}]}},
   txResources:[
     {resourceType:"CodeSystem",url:"http://example.org/cs/palette",status:"active",content:"complete",concept:[{code:"red",display:"Red"},{code:"orange",display:"Orange"},{code:"blue",display:"Blue"}]},
     {resourceType:"ValueSet",url:"http://example.org/vs/warm-colors",status:"active",compose:{include:[{system:"http://example.org/cs/palette",concept:[{code:"red"},{code:"orange"}]}]}}
   ],
   params:{}},
];
})(typeof globalThis !== 'undefined' ? globalThis : window);
