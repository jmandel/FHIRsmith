#!/usr/bin/env node
'use strict';

process.argv.splice(2, 0, '--impl', 'v3');
require('./expand-adhoc');
