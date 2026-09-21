/**
 * The register's stylesheet (slice 13.3; design record, Component register).
 *
 * Components render semantic markup with `pb-*` classes and leave every state a
 * stylesheet can express — hover, focus-visible, disabled, invalid, reduced
 * motion — to these rules. A surface inlines the sheet beside the tokens'
 * `themeStyleSheet`; it never writes a `pb-*` class itself, which is what the
 * register lint rule in `@porkbot/eslint-config` enforces.
 *
 * Every value is a `--pb-*` custom property or a `color-mix` of them, so no
 * surface and no rule carries a colour literal; `style-sheet.test.ts` walks the
 * sheet and fails on one.
 */

export const registerStyleSheet = `
.pb-button{display:inline-flex;align-items:center;justify-content:center;gap:var(--pb-space-xs);padding:var(--pb-space-sm) var(--pb-space-md);border:1px solid transparent;border-radius:var(--pb-radius-lg);font-family:var(--pb-font-sans);font-size:var(--pb-type-body-size);line-height:var(--pb-type-body-line-height);font-weight:500;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background-color var(--pb-motion-fast) var(--pb-motion-standard),color var(--pb-motion-fast) var(--pb-motion-standard),border-color var(--pb-motion-fast) var(--pb-motion-standard)}
.pb-button--primary{background:var(--pb-color-accent);color:var(--pb-color-accent-foreground);border-color:var(--pb-color-accent)}
.pb-button--primary:hover:not(:disabled){background:color-mix(in srgb,var(--pb-color-accent) 88%,var(--pb-color-foreground))}
.pb-button--neutral{background:var(--pb-color-surface);color:var(--pb-color-foreground);border-color:var(--pb-color-border)}
.pb-button--neutral:hover:not(:disabled){background:var(--pb-color-raised)}
.pb-button--ghost{background:transparent;color:var(--pb-color-foreground)}
.pb-button--ghost:hover:not(:disabled){background:var(--pb-color-raised)}
.pb-button--destructive{background:var(--pb-color-destructive);color:var(--pb-color-destructive-foreground);border-color:var(--pb-color-destructive)}
.pb-button--destructive:hover:not(:disabled){background:color-mix(in srgb,var(--pb-color-destructive) 88%,var(--pb-color-foreground))}
.pb-button:focus-visible,.pb-icon-button:focus-visible{outline:2px solid var(--pb-color-accent);outline-offset:2px}
.pb-button:disabled,.pb-icon-button:disabled{opacity:0.6;cursor:not-allowed}
.pb-button[aria-busy="true"],.pb-icon-button[aria-busy="true"]{cursor:progress}
.pb-button__spinner{width:0.875rem;height:0.875rem;border:2px solid color-mix(in srgb,currentColor 35%,transparent);border-top-color:currentColor;border-radius:var(--pb-radius-pill);animation:pb-spin 800ms linear infinite}
@keyframes pb-spin{to{transform:rotate(360deg)}}
.pb-icon-button{display:inline-flex;align-items:center;justify-content:center;width:2rem;height:2rem;padding:0;border:1px solid transparent;border-radius:var(--pb-radius-lg);color:var(--pb-color-foreground);background:transparent;cursor:pointer;transition:background-color var(--pb-motion-fast) var(--pb-motion-standard)}
.pb-icon-button--neutral{background:var(--pb-color-surface);border-color:var(--pb-color-border)}
.pb-icon-button--primary{background:var(--pb-color-accent);color:var(--pb-color-accent-foreground)}
.pb-icon-button--destructive{background:var(--pb-color-destructive);color:var(--pb-color-destructive-foreground)}
.pb-icon-button:hover:not(:disabled){background:var(--pb-color-raised)}
.pb-field{display:flex;flex-direction:column;gap:var(--pb-space-xs)}
.pb-field__label{font-size:var(--pb-type-meta-size);line-height:var(--pb-type-meta-line-height);font-weight:var(--pb-type-meta-weight);color:var(--pb-color-muted)}
.pb-field__hint{margin:0;font-size:var(--pb-type-meta-size);line-height:var(--pb-type-meta-line-height);color:var(--pb-color-muted)}
.pb-field__error{margin:0;font-size:var(--pb-type-meta-size);line-height:var(--pb-type-meta-line-height);color:var(--pb-color-destructive)}
.pb-input,.pb-textarea,.pb-select{width:100%;padding:var(--pb-space-sm);color:var(--pb-color-foreground);background:var(--pb-color-background);border:1px solid var(--pb-color-border);border-radius:var(--pb-radius-lg);font-family:inherit;font-size:var(--pb-type-body-size);line-height:var(--pb-type-body-line-height)}
.pb-input:focus-visible,.pb-textarea:focus-visible,.pb-select:focus-visible{outline:2px solid var(--pb-color-accent);outline-offset:1px;border-color:var(--pb-color-accent)}
.pb-input[aria-invalid="true"],.pb-textarea[aria-invalid="true"],.pb-select[aria-invalid="true"]{border-color:var(--pb-color-destructive)}
.pb-input:disabled,.pb-textarea:disabled,.pb-select:disabled{opacity:0.6;cursor:not-allowed}
.pb-input[type="checkbox"],.pb-input[type="radio"]{width:auto;accent-color:var(--pb-color-accent)}
.pb-textarea{resize:vertical}
.pb-badge{display:inline-flex;align-items:center;gap:var(--pb-space-2xs);padding:var(--pb-space-2xs) var(--pb-space-sm);background:var(--pb-color-raised);color:var(--pb-color-foreground);border:1px solid var(--pb-color-border);border-radius:var(--pb-radius-pill);font-size:var(--pb-type-meta-size);line-height:var(--pb-type-meta-line-height);font-weight:var(--pb-type-meta-weight);white-space:nowrap}
.pb-badge--accent{background:color-mix(in srgb,var(--pb-color-accent) 14%,var(--pb-color-surface));border-color:color-mix(in srgb,var(--pb-color-accent) 40%,var(--pb-color-border));color:var(--pb-color-accent)}
.pb-badge--success{background:color-mix(in srgb,var(--pb-color-success) 14%,var(--pb-color-surface));border-color:color-mix(in srgb,var(--pb-color-success) 40%,var(--pb-color-border));color:var(--pb-color-success)}
.pb-badge--warning{background:color-mix(in srgb,var(--pb-color-warning) 14%,var(--pb-color-surface));border-color:color-mix(in srgb,var(--pb-color-warning) 40%,var(--pb-color-border));color:var(--pb-color-warning)}
.pb-badge--info{background:color-mix(in srgb,var(--pb-color-info) 14%,var(--pb-color-surface));border-color:color-mix(in srgb,var(--pb-color-info) 40%,var(--pb-color-border));color:var(--pb-color-info)}
.pb-badge--destructive{background:color-mix(in srgb,var(--pb-color-destructive) 14%,var(--pb-color-surface));border-color:color-mix(in srgb,var(--pb-color-destructive) 40%,var(--pb-color-border));color:var(--pb-color-destructive)}
.pb-count-badge{display:inline-flex;align-items:center;justify-content:center;min-width:1.125rem;padding:0 var(--pb-space-2xs);background:var(--pb-color-accent);color:var(--pb-color-accent-foreground);border-radius:var(--pb-radius-pill);font-size:var(--pb-type-meta-size);line-height:var(--pb-type-meta-line-height);font-weight:600}
.pb-state-chip{display:inline-flex;align-items:center;gap:var(--pb-space-xs);font-size:var(--pb-type-meta-size);line-height:var(--pb-type-meta-line-height);font-weight:var(--pb-type-meta-weight);color:var(--pb-color-muted);white-space:nowrap}
.pb-state-chip--working,.pb-state-chip--stuck,.pb-state-chip--failed,.pb-state-chip--waiting{color:var(--pb-color-foreground)}
.pb-state-chip__dot{width:0.5rem;height:0.5rem;flex:none;border-radius:var(--pb-radius-pill);background:var(--pb-color-muted)}
.pb-state-chip--idle .pb-state-chip__dot,.pb-state-chip--stopped .pb-state-chip__dot{background:transparent;border:1px solid var(--pb-color-muted)}
.pb-state-chip--working .pb-state-chip__dot{background:var(--pb-state-chip-color,var(--pb-color-accent));animation:pb-pulse var(--pb-motion-ambient) ease-in-out infinite}
.pb-state-chip--waiting .pb-state-chip__dot{background:var(--pb-color-accent)}
.pb-state-chip--stuck .pb-state-chip__dot{background:var(--pb-color-warning);box-shadow:0 0 0 2px color-mix(in srgb,var(--pb-color-warning) 30%,transparent)}
.pb-state-chip--failed .pb-state-chip__dot{background:var(--pb-color-destructive)}
@keyframes pb-pulse{0%,100%{opacity:1}50%{opacity:0.55}}
.pb-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;overflow:hidden;background:var(--pb-color-raised);border-radius:var(--pb-radius-pill)}
.pb-avatar--20{width:1.25rem;height:1.25rem}
.pb-avatar--24{width:1.5rem;height:1.5rem}
.pb-avatar--32{width:2rem;height:2rem}
.pb-avatar--40{width:2.5rem;height:2.5rem}
.pb-avatar__image{width:100%;height:100%;object-fit:cover}
.pb-card{display:flex;flex-direction:column;gap:var(--pb-space-md);padding:var(--pb-space-lg);background:var(--pb-color-surface);border:1px solid var(--pb-color-border);border-radius:var(--pb-radius-xl)}
.pb-card--raised{box-shadow:var(--pb-elevation-raised)}
.pb-card--interactive{cursor:pointer;box-shadow:var(--pb-elevation-raised);transition:background-color var(--pb-motion-fast) var(--pb-motion-standard)}
.pb-card--interactive:hover{background:var(--pb-color-raised)}
.pb-card>h1,.pb-card>h2,.pb-card>h3{margin:0;font-size:var(--pb-type-title-size);line-height:var(--pb-type-title-line-height);font-weight:var(--pb-type-title-weight)}
.pb-separator{border:0;background:var(--pb-color-border)}
.pb-separator--horizontal{width:100%;height:1px;margin:0}
.pb-separator--vertical{width:1px;height:100%;min-height:1rem;align-self:stretch}
.pb-scroll-area{overflow:auto;overscroll-behavior:contain;min-height:0}
.pb-scroll-area:focus-within{outline:2px solid var(--pb-color-accent);outline-offset:-2px}
.pb-tabs{display:flex;flex-direction:column;gap:var(--pb-space-md)}
.pb-tab-list{display:flex;gap:var(--pb-space-xs);border-bottom:1px solid var(--pb-color-border)}
.pb-tab{padding:var(--pb-space-xs) var(--pb-space-sm);background:transparent;border:0;border-bottom:2px solid transparent;color:var(--pb-color-muted);font-family:inherit;font-size:var(--pb-type-body-size);line-height:var(--pb-type-body-line-height);cursor:pointer}
.pb-tab:hover{color:var(--pb-color-foreground);background:var(--pb-color-raised)}
.pb-tab[aria-selected="true"]{color:var(--pb-color-foreground);border-bottom-color:var(--pb-color-accent)}
.pb-tab:focus-visible{outline:2px solid var(--pb-color-accent);outline-offset:-2px}
.pb-tab-panel{min-height:0}
.pb-menu{position:relative;display:inline-block}
.pb-menu__popup{position:absolute;top:calc(100% + var(--pb-space-xs));left:0;z-index:30;min-width:12rem;display:flex;flex-direction:column;gap:var(--pb-space-2xs);padding:var(--pb-space-xs);background:var(--pb-color-surface);border:1px solid var(--pb-color-border);border-radius:var(--pb-radius-xl);box-shadow:var(--pb-elevation-overlay)}
.pb-menu__popup--end{left:auto;right:0}
.pb-menu__item{display:flex;align-items:center;gap:var(--pb-space-sm);width:100%;padding:var(--pb-space-xs) var(--pb-space-sm);background:transparent;border:0;border-radius:var(--pb-radius-lg);color:var(--pb-color-foreground);font-family:inherit;font-size:var(--pb-type-body-size);line-height:var(--pb-type-body-line-height);text-align:left;cursor:pointer}
.pb-menu__item:hover:not(:disabled){background:var(--pb-color-raised)}
.pb-menu__item:focus-visible{outline:2px solid var(--pb-color-accent);outline-offset:-2px}
.pb-menu__item--destructive{color:var(--pb-color-destructive)}
.pb-menu__item:disabled{opacity:0.6;cursor:not-allowed}
.pb-dialog{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:var(--pb-space-lg);background:color-mix(in srgb,var(--pb-color-foreground) 45%,transparent);animation:pb-fade var(--pb-motion-base) var(--pb-motion-standard)}
.pb-dialog__panel{width:min(28rem,100%);max-height:calc(100vh - 2 * var(--pb-space-lg));overflow:auto;display:flex;flex-direction:column;gap:var(--pb-space-md);padding:var(--pb-space-xl);background:var(--pb-color-surface);border:1px solid var(--pb-color-border);border-radius:var(--pb-radius-xl);box-shadow:var(--pb-elevation-overlay)}
.pb-dialog__panel:focus{outline:none}
.pb-dialog__title{margin:0;font-size:var(--pb-type-title-size);line-height:var(--pb-type-title-line-height);font-weight:var(--pb-type-title-weight)}
.pb-dialog__description{margin:0;color:var(--pb-color-muted);font-size:var(--pb-type-body-size);line-height:var(--pb-type-body-line-height)}
.pb-dialog__actions{display:flex;justify-content:flex-end;gap:var(--pb-space-sm)}
.pb-sheet{align-items:flex-end;padding:0}
.pb-sheet .pb-dialog__panel{width:100%;max-width:none;max-height:90vh;border-radius:var(--pb-radius-xl) var(--pb-radius-xl) 0 0;animation:pb-rise var(--pb-motion-base) var(--pb-motion-standard)}
@keyframes pb-fade{from{opacity:0}}
@keyframes pb-rise{from{transform:translateY(1rem);opacity:0}}
@keyframes pb-enter{from{transform:translateY(0.25rem);opacity:0}}
.pb-tooltip{position:relative;display:inline-flex}
.pb-tooltip__bubble{position:absolute;bottom:calc(100% + var(--pb-space-xs));left:50%;transform:translateX(-50%);z-index:50;max-width:16rem;padding:var(--pb-space-xs) var(--pb-space-sm);background:var(--pb-color-raised);color:var(--pb-color-foreground);border:1px solid var(--pb-color-border);border-radius:var(--pb-radius-lg);box-shadow:var(--pb-elevation-overlay);font-size:var(--pb-type-meta-size);line-height:var(--pb-type-meta-line-height)}
.pb-toast-region{position:fixed;right:var(--pb-space-lg);bottom:var(--pb-space-lg);z-index:60;display:flex;flex-direction:column;gap:var(--pb-space-sm);width:min(22rem,calc(100vw - 2 * var(--pb-space-lg)))}
.pb-toast{display:flex;flex-direction:column;gap:var(--pb-space-xs);padding:var(--pb-space-md);background:var(--pb-color-surface);border:1px solid var(--pb-color-border);border-left:3px solid var(--pb-color-muted);border-radius:var(--pb-radius-xl);box-shadow:var(--pb-elevation-overlay);animation:pb-enter var(--pb-motion-base) var(--pb-motion-standard)}
.pb-toast--success{border-left-color:var(--pb-color-success)}
.pb-toast--warning{border-left-color:var(--pb-color-warning)}
.pb-toast--destructive{border-left-color:var(--pb-color-destructive)}
.pb-toast__header{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--pb-space-sm)}
.pb-toast__title{font-size:var(--pb-type-body-size);line-height:var(--pb-type-body-line-height);font-weight:600}
.pb-toast__body{margin:0;color:var(--pb-color-muted);font-size:var(--pb-type-body-size);line-height:var(--pb-type-body-line-height)}
.pb-toast__actions{display:flex;gap:var(--pb-space-sm)}
.pb-skeleton{display:block;background:var(--pb-color-raised);border-radius:var(--pb-radius-md);animation:pb-pulse var(--pb-motion-ambient) ease-in-out infinite}
.pb-skeleton-group{display:flex;flex-direction:column;gap:var(--pb-space-sm)}
@media (prefers-reduced-motion:reduce){
.pb-button,.pb-icon-button,.pb-card--interactive{transition-duration:var(--pb-motion-instant)}
.pb-skeleton,.pb-state-chip--working .pb-state-chip__dot,.pb-button__spinner{animation:none}
.pb-dialog,.pb-toast,.pb-sheet .pb-dialog__panel{animation:none}
}
`;
