<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('password','password-confirm'); section>
  <#if section = "header">
    ${msg("updatePasswordTitle")}
  <#elseif section = "form">
    <form id="kc-passwd-update-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
      <div class="${properties.kcFormGroupClass!}">
        <label for="password-new" class="${properties.kcLabelClass!}">${msg("passwordNew")}</label>
        <div class="${properties.kcInputGroup!}" dir="ltr">
          <input type="password" id="password-new" name="password-new" class="${properties.kcInputClass!}" autofocus autocomplete="new-password"
                 aria-invalid="<#if messagesPerField.existsError('password','password-confirm')>true</#if>"
          />
          <button class="${properties.kcFormPasswordVisibilityButtonClass!}" type="button" aria-label="${msg('showPassword')}" aria-controls="password-new" data-password-toggle
                  data-label-show="${msg('showPassword')}" data-label-hide="${msg('hidePassword')}">
            <svg class="csq-icon-eye" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="csq-icon-eye-off" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C4 8.5 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/></svg>
          </button>
        </div>
        <#if messagesPerField.existsError('password')>
          <span id="input-error-password" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
            ${kcSanitize(messagesPerField.get('password'))?no_esc}
          </span>
        </#if>
      </div>

      <div class="${properties.kcFormGroupClass!}">
        <label for="password-confirm" class="${properties.kcLabelClass!}">${msg("passwordConfirm")}</label>
        <div class="${properties.kcInputGroup!}" dir="ltr">
          <input type="password" id="password-confirm" name="password-confirm" class="${properties.kcInputClass!}" autocomplete="new-password"
                 aria-invalid="<#if messagesPerField.existsError('password-confirm')>true</#if>"
          />
          <button class="${properties.kcFormPasswordVisibilityButtonClass!}" type="button" aria-label="${msg('showPassword')}" aria-controls="password-confirm" data-password-toggle
                  data-label-show="${msg('showPassword')}" data-label-hide="${msg('hidePassword')}">
            <svg class="csq-icon-eye" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="csq-icon-eye-off" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C4 8.5 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/></svg>
          </button>
        </div>
        <#if messagesPerField.existsError('password-confirm')>
          <span id="input-error-password-confirm" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
            ${kcSanitize(messagesPerField.get('password-confirm'))?no_esc}
          </span>
        </#if>
      </div>

      <div class="${properties.kcFormGroupClass!} ${properties.kcFormSettingClass!}" id="kc-form-options">
        <label class="csq-check">
          <input type="checkbox" id="logout-sessions" name="logout-sessions" value="on" class="${properties.kcCheckboxInputClass!}" checked>
          <span>${msg("logoutOtherSessions")}</span>
        </label>
      </div>

      <div id="kc-form-buttons" class="${properties.kcFormGroupClass!} ${properties.kcFormButtonsClass!}">
        <#if isAppInitiatedAction??>
          <input class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" type="submit" value="${msg("doSubmit")}" />
          <button class="${properties.kcButtonClass!} ${properties.kcButtonDefaultClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" type="submit" name="cancel-aia" value="true">${msg("doCancel")}</button>
        <#else>
          <input class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" type="submit" value="${msg("doSubmit")}" />
        </#if>
      </div>
    </form>
  </#if>
</@layout.registrationLayout>
