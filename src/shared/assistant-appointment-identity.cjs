function assistantAppointmentStamp(appointment) {
  const item = appointment || {};
  return JSON.stringify([
    item.id || '',
    item.date || '',
    item.time || '',
    Number(item.duration || 60),
    item.staffId || '',
    item.roomId || '',
    item.status || 'scheduled',
    item.service || '',
    (item.serviceItems || []).map((service) => [
      service.id || '',
      service.name || '',
      Number(service.duration || 0),
      Number(service.price || 0),
      service.staffId || '',
    ]),
  ]);
}
function createAssistantAppointmentIdentity() {
  return { assistantAppointmentStamp };
}
if (typeof module !== 'undefined' && module.exports)
  module.exports = { assistantAppointmentStamp, createAssistantAppointmentIdentity };
