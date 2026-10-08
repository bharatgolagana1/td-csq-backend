<#-- The page frame every login-flow page renders into: brand header, the card
     on the left over the landing page's nose image, the statement on the right,
     footer. Pages fill the "header", "form", "info", "socialProviders" and
     "show-username" sections, as in Keycloak's base theme. -->
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}"<#if realm.internationalizationEnabled> lang="${locale.currentLanguageTag}"</#if>>
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex, nofollow">
  <#if properties.meta?has_content>
    <#list properties.meta?split(' ') as meta>
      <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
    </#list>
  </#if>
  <title>${msg("loginTitle",(realm.displayName!''))}</title>
  <link rel="icon" href="${url.resourcesPath}/img/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..124,400..850&family=IBM+Plex+Mono:wght@400;600&display=swap">
  <#if properties.styles?has_content>
    <#list properties.styles?split(' ') as style>
      <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
    </#list>
  </#if>
  <#if scripts??>
    <#list scripts as script>
      <script src="${script}" type="text/javascript"></script>
    </#list>
  </#if>
</head>

<body class="${properties.kcBodyClass!} ${bodyClass}">
<div class="${properties.kcLoginClass!}">
  <picture class="csq-bg" aria-hidden="true">
    <source type="image/avif" srcset="${url.resourcesPath}/img/nose-900.avif 900w, ${url.resourcesPath}/img/nose-1440.avif 1440w" sizes="100vw">
    <source type="image/webp" srcset="${url.resourcesPath}/img/nose-900.webp 900w, ${url.resourcesPath}/img/nose-1440.webp 1440w" sizes="100vw">
    <img src="${url.resourcesPath}/img/nose-1440.jpg" alt="" decoding="async" fetchpriority="high">
  </picture>
  <div class="csq-veil" aria-hidden="true"></div>

  <header class="${properties.kcHeaderClass!}">
    <a class="csq-brand" href="${properties.csqHomeUrl!'/'}">
      <span class="csq-brand-mark">CSQ</span>
      <span class="csq-brand-name">${msg("csqBrandName")}</span>
    </a>
    <div class="csq-header-right">
      <#if realm.internationalizationEnabled && locale.supported?size gt 1>
        <nav class="${properties.kcLocaleMainClass!}" id="kc-locale" aria-label="${msg("languages")}">
          <ul>
            <#list locale.supported as l>
              <li><a href="${l.url}"<#if l.languageTag == locale.currentLanguageTag> aria-current="true"</#if>>${l.label}</a></li>
            </#list>
          </ul>
        </nav>
      </#if>
      <a class="csq-back" href="${properties.csqHomeUrl!'/'}"><span aria-hidden="true">&larr;</span> ${msg("csqBackHome")}</a>
    </div>
  </header>

  <main class="csq-main">
    <section class="${properties.kcFormCardClass!}" id="kc-card">
      <header class="${properties.kcFormHeaderClass!}">
        <p class="csq-kicker">${msg("csqKicker")}</p>
        <#if !(auth?has_content && auth.showUsername() && !auth.showResetCredentials())>
          <h1 id="kc-page-title" class="csq-title"><#nested "header"></h1>
        <#else>
          <#nested "show-username">
          <h1 id="kc-page-title" class="csq-title"><#nested "header"></h1>
          <div id="kc-username" class="csq-attempted">
            <span id="kc-attempted-username">${auth.attemptedUsername}</span>
            <a id="reset-login" href="${url.loginRestartFlowUrl}" aria-label="${msg("restartLoginTooltip")}">${msg("restartLoginTooltip")}</a>
          </div>
        </#if>
        <#if displayRequiredFields>
          <p class="csq-required"><span class="required">*</span> ${msg("requiredFields")}</p>
        </#if>
      </header>

      <div id="kc-content">
        <div id="kc-content-wrapper">
          <#-- App-initiated actions should not see warning messages about the need to complete the action during login. -->
          <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
            <div class="${properties.kcAlertClass!} csq-alert-${message.type}" role="<#if message.type = 'error'>alert<#else>status</#if>">
              <span class="${properties.kcAlertTitleClass!}">${kcSanitize(message.summary)?no_esc}</span>
            </div>
          </#if>

          <#nested "form">

          <#if auth?has_content && auth.showTryAnotherWayLink()>
            <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post" class="csq-try-another">
              <input type="hidden" name="tryAnotherWay" value="on"/>
              <a href="#" id="try-another-way" class="csq-link" onclick="document.forms['kc-select-try-another-way-form'].submit();return false;">${msg("doTryAnotherWay")}</a>
            </form>
          </#if>

          <#nested "socialProviders">

          <#if displayInfo>
            <div id="kc-info" class="${properties.kcSignUpClass!}">
              <div id="kc-info-wrapper" class="${properties.kcInfoAreaWrapperClass!}">
                <#nested "info">
              </div>
            </div>
          </#if>
        </div>
      </div>
    </section>

    <aside class="csq-aside" aria-hidden="true">
      <p class="csq-aside-kicker">${msg("csqAsideKicker")}</p>
      <p class="csq-aside-text">${msg("csqAsideText")}</p>
    </aside>
  </main>

  <footer class="csq-footer">
    <span>${msg("csqFooterLeft")}</span>
    <span>${msg("csqFooterRight")}</span>
  </footer>
</div>
<#if properties.scripts?has_content>
  <#list properties.scripts?split(' ') as script>
    <script src="${url.resourcesPath}/${script}" defer></script>
  </#list>
</#if>
</body>
</html>
</#macro>
