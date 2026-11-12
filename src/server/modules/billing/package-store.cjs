const { createPackageContext } = require('./package-context.cjs');
const { createServiceCatalog } = require('./service-catalog.cjs');
const { createPackageCatalog } = require('./package-catalog.cjs');
const { createPackageGrants } = require('./package-grants.cjs');
const { createPackageTasks } = require('./package-tasks.cjs');
function createPackageStore(context) {
  const core = createPackageContext(context),
    services = createServiceCatalog(core),
    catalog = createPackageCatalog(core, services),
    grants = createPackageGrants(core, catalog, services),
    tasks = createPackageTasks(core, grants, services);
  return {
    available: core.available,
    services: services.catalog,
    multipleServices: services.multiple,
    catalog: catalog.catalog,
    definition: catalog.definition,
    adminCatalog: catalog.adminCatalog,
    savePackage: catalog.savePackage,
    status: grants.status,
    grantTrial: grants.grantTrial,
    revokeOrder: grants.revokeOrder,
    fulfillPaidOrder: grants.fulfillPaidOrder,
    fulfillPaidOrderInTransaction: grants.fulfillPaidOrderInTransaction,
    ...tasks,
  };
}
module.exports = { createPackageStore };
