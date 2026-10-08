// Show/hide password buttons. No dependency on Keycloak's own scripts.
(function () {
  var buttons = document.querySelectorAll('[data-password-toggle]');
  for (var i = 0; i < buttons.length; i += 1) {
    buttons[i].addEventListener('click', function (event) {
      var button = event.currentTarget;
      var input = document.getElementById(button.getAttribute('aria-controls'));
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.classList.toggle('is-on', show);
      button.setAttribute('aria-label', show ? button.getAttribute('data-label-hide') : button.getAttribute('data-label-show'));
      button.setAttribute('aria-pressed', show ? 'true' : 'false');
    });
  }
})();
