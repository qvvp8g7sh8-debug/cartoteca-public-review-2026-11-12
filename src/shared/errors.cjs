const fail = (status, message) => Object.assign(new Error(message), { status });
module.exports = { fail };
