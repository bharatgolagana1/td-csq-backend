<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>
  <#if section = "header">
    ${msg("loginAccountTitle")}
  <#elseif section = "form">
    <div id="kc-form">
      <div id="kc-form-wrapper">
        <#if realm.password>
          <form id="kc-form-login" class="${properties.kcFormClass!}" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post">
            <#if !usernameHidden??>
              <div class="${properties.kcFormGroupClass!}">
                <label for="username" class="${properties.kcLabelClass!}"><#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if></label>
                <input tabindex="2" id="username" class="${properties.kcInputClass!}" name="username" value="${(login.username!'')}" type="text" autofocus autocomplete="username" autocapitalize="none" spellcheck="false"
                       aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"
                />
                <#if messagesPerField.existsError('username','password')>
                  <span id="input-error" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
                    ${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}
                  </span>
                </#if>
              </div>
            </#if>

            <div class="${properties.kcFormGroupClass!}">
              <div class="csq-label-row">
                <label for="password" class="${properties.kcLabelClass!}">${msg("password")}</label>
                <#if realm.resetPasswordAllowed>
                  <a tabindex="6" class="csq-link" href="${url.loginResetCredentialsUrl}">${msg("doForgotPassword")}</a>
                </#if>
              </div>
              <div class="${properties.kcInputGroup!}" dir="ltr">
                <input tabindex="3" id="password" class="${properties.kcInputClass!}" name="password" type="password" autocomplete="current-password"
                       aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"
                />
                <button class="${properties.kcFormPasswordVisibilityButtonClass!}" type="button" aria-label="${msg('showPassword')}"
                        aria-controls="password" data-password-toggle tabindex="4"
                        data-label-show="${msg('showPassword')}" data-label-hide="${msg('hidePassword')}">
                  <svg class="csq-icon-eye" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                  <svg class="csq-icon-eye-off" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C4 8.5 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/></svg>
                </button>
              </div>
              <#if usernameHidden?? && messagesPerField.existsError('username','password')>
                <span id="input-error" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
                  ${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}
                </span>
              </#if>
            </div>

            <#if realm.rememberMe && !usernameHidden??>
              <div class="${properties.kcFormGroupClass!} ${properties.kcFormSettingClass!}" id="kc-form-options">
                <label class="csq-check">
                  <input tabindex="5" id="rememberMe" name="rememberMe" type="checkbox" class="${properties.kcCheckboxInputClass!}"<#if login.rememberMe??> checked</#if>>
                  <span>${msg("rememberMe")}</span>
                </label>
              </div>
            </#if>

            <div id="kc-form-buttons" class="${properties.kcFormGroupClass!} ${properties.kcFormButtonsClass!}">
              <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
              <input tabindex="7" class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" name="login" id="kc-login" type="submit" value="${msg("doLogIn")}"/>
            </div>
          </form>
        </#if>
      </div>
    </div>
  <#elseif section = "info">
    <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
      <div id="kc-registration-container">
        <div id="kc-registration">
          <span>${msg("noAccount")} <a tabindex="8" class="csq-link" href="${url.registrationUrl}">${msg("doRegister")}</a></span>
        </div>
      </div>
    </#if>
  <#elseif section = "socialProviders">
    <#if realm.password && social?? && social.providers?has_content>
      <div id="kc-social-providers" class="${properties.kcFormSocialAccountSectionClass!}">
        <p class="csq-label csq-social-heading">${msg("identity-provider-login-label")}</p>
        <ul class="${properties.kcFormSocialAccountListClass!}">
          <#list social.providers as p>
            <li>
              <a id="social-${p.alias}" class="${properties.kcFormSocialAccountListButtonClass!}" href="${p.loginUrl}">
                <span>${p.displayName!}</span>
              </a>
            </li>
          </#list>
        </ul>
      </div>
    </#if>
  </#if>
</@layout.registrationLayout>
