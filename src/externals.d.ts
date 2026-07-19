// Shims para os pacotes de build-time do Lingui/Babel usados por
// `linguiMacroTs` (vite.ts) e `genPo` (genpo.ts). São dependências externas
// (resolvidas no projeto consumidor em tempo de build) e alguns não publicam
// tipos — declaramos como `any` só para o `tsc --emitDeclarationOnly`.
declare module '@babel/core';
declare module '@babel/preset-typescript';
declare module '@lingui/babel-plugin-lingui-macro';
declare module '@lingui/format-po';
