const {createPlatformStore}=require('./src/server/application/platform.cjs');
const {FREE_LIMITS,roles,SESSION_MS,LOGIN_MAX_FAILURES,LOGIN_ATTEMPT_WINDOW_MS,LOGIN_BLOCK_MS}=require('./src/server/infrastructure/platform-constants.cjs');
module.exports={createPlatformStore,FREE_LIMITS,roles,SESSION_MS,LOGIN_MAX_FAILURES,LOGIN_ATTEMPT_WINDOW_MS,LOGIN_BLOCK_MS};
