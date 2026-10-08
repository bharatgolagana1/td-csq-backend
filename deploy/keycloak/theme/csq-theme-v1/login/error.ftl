<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">
    ${msg("errorTitle")}
  <#elseif section = "form">
    <div id="kc-error-message">
      <p class="instruction">${kcSanitize(message.summary)?no_esc}</p>
      <#if !skipLink??>
        <div class="${properties.kcFormButtonsClass!}">
          <#if client?? && client.baseUrl?has_content>
            <a id="backToApplication" class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!}" href="${client.baseUrl}">${kcSanitize(msg("backToApplication"))?no_esc}</a>
          <#else>
            <a id="backToApplication" class="${properties.kcButtonClass!} ${properties.kcButtonDefaultClass!} ${properties.kcButtonBlockClass!}" href="${properties.csqHomeUrl!'/'}">${msg("csqBackHomeLong")}</a>
          </#if>
        </div>
      </#if>
    </div>
  </#if>
</@layout.registrationLayout>
