// The SDK depends on the discontinued lodash.set package. The maintained
// lodash implementation has the same API and blocks prototype traversal.
module.exports = require('lodash/set.js');
