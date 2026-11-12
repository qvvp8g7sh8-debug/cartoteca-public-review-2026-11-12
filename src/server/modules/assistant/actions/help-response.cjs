function helpText(current, commands = {}, guidance = null) {
  if (
    !current?.organizationId ||
    current.globalAdmin ||
    !['owner', 'salon_admin', 'cosmetologist'].includes(current.role)
  )
    return 'Помощник доступен сотрудникам выбранной организации с разрешением администратора.';
  if (
    ![commands.prepareAppointment, commands.clients, commands.calendar].some(
      (value) => value === true,
    )
  )
    return 'Действия помощника выключены администратором.';
  if (guidance === 'capabilities' || guidance === 'unsupportedCard') {
    const options = [];
    if (commands.calendar === true) options.push('показать расписание и свободные окна');
    if (commands.clients === true) options.push('найти клиента и открыть его карточку');
    if (commands.prepareAppointment === true)
      options.push('подготовить запись для проверки и ручного сохранения');
    const available =
      'Могу ' +
      (options.length > 1
        ? options.slice(0, -1).join(', ') + ' или ' + options.at(-1)
        : options[0]) +
      '. Что нужно сделать?';
    return guidance === 'unsupportedCard'
      ? 'Этот тип карты помощник не открывает. ' + available
      : available;
  }
  return 'Что нужно сделать?';
}
module.exports = { helpText };
