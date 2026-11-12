// JSDOM does not implement native dialog lifecycle. Preserve explicit test decisions.
function installActionConfirmation(window, { automatic = true } = {}) {
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    if (automatic && this.id === 'action-confirmation') {
      const dialog = this;
      queueMicrotask(() => {
        if (!dialog.open) return;
        const accepted = window.confirm(dialog.querySelector('p').textContent);
        dialog.querySelector(accepted ? '[data-confirm-accept]' : '[data-confirm-cancel]').click();
      });
    }
  };
  window.HTMLDialogElement.prototype.close = function (value) {
    if (value !== undefined) this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
}
module.exports = { installActionConfirmation };
