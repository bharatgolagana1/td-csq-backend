<#import "template.ftl" as layout>
<@layout.registrationLayout displayInfo=true displayMessage=!messagesPerField.existsError('username'); section>
  <#if section = "header">
    ${msg("emailForgotTitle")}
  <#elseif section = "form">
    <form id="kc-reset-password-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
      <div class="${properties.kcFormGroupClass!}">
        <label for="username" class="${properties.kcLabelClass!}"><#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if></label>
        <input type="text" id="username" name="username" class="${properties.kcInputClass!}" autofocus autocomplete="username" autocapitalize="none" spellcheck="false" value="${(auth.attemptedUsername!'')}"
               aria-invalid="<#if messagesPerField.existsError('username')>true</#if>"/>
        <#if messagesPerField.existsError('username')>
          <span id="input-error-username" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
            ${kcSanitize(messagesPerField.get('username'))?no_esc}
          </span>
        </#if>
      </div>
      <div id="kc-form-buttons" class="${properties.kcFormGroupClass!} ${properties.kcFormButtonsClass!}">
        <input class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" type="submit" value="${msg("doSubmit")}"/>
        <a class="${properties.kcButtonClass!} ${properties.kcButtonDefaultClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" href="${url.loginUrl}">${kcSanitize(msg("backToLogin"))?no_esc}</a>
      </div>
    </form>
  <#elseif section = "info">
    <#if realm.duplicateEmailsAllowed>
      ${msg("emailInstructionUsername")}
    <#else>
      ${msg("emailInstruction")}
    </#if>
  </#if>
</@layout.registrationLayout>
