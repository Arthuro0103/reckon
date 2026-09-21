---
Scope: lib/platform, lib/pressure.js, web/ (reckon) · Sources/NotchNucleo/Medida, Sources/NotchApp/Medida, scripts/ (notch)
version: 2.0.0
updated_at: "2026-09-21T22:39:38Z"
last_commit: "edba94f"
warm_tasks: []
decisions:
  - "A moeda da pressão é segundo roubado, não gigabyte ocupado — reckon já rankeia bytes e isso não enxergava 365 processos de 171 MB."
  - "reckon julga e entrega o comando; notch avisa. Painel é coisa que se abre, e ele não abre antes de sentir dor."
  - "A base da sonda é conquistada (menor tempo já medido), nunca configurada."
  - "Duas leituras ruins seguidas pra acender: uma só acende a cada swift build e o alarme vira paisagem."
blockers: []
suggested_next: "`npm start` no reckon e abrir `#pressure` — confirmar que a aba desenha."
---

# Session Brief — 2026-09-21

## Last Session Summary

Sessão começou como diagnóstico ("por que meu computador está lento, principalmente o
Orca") e virou três entregas. A causa: 365 processos `yes` órfãos vazados de rodadas de
teste sob carga de 20/09, girando havia 26 horas. `load average` 539 em 10 núcleos.

## Current State

- **reckon** — `main`, limpo fora de `reckon-report.txt`, que **já estava modificado antes
  desta sessão** e não foi tocado. 2 commits novos.
- **notch** — `main`, árvore limpa. 3 commits novos. 762 testes verdes, `confere-leis: OK`.
- Ambos **sem push**.
- Máquina: de `load 539` / laço de 6,14 s para `load 12` / laço de 0,30 s. Swap de 13 GB
  para 7,7 GB.

## What Shipped

**reckon**
- `5816aee` platform: `processList()` ganhou `ppid`, `ageS`, `tty`, `orphaned`,
  `systemManaged`; `listeningPorts()` como capacidade opcional; darwin + win32 + CONTRACT.
- `edba94f` pressure: `lib/pressure.js`, rota `/api/pressure`, aba nova no painel.

**notch**
- `0b5978d` carga: `scripts/sob-carga.sh` — carga com `trap` que garante a limpeza.
- `439ebe0` pressão: `MedidaDePressao` no núcleo + 12 testes.
- `e818c50` vigia: `VigiaDePressao` no app + aviso na placa.

## Decisões Tomadas

- **Segundos, não bytes.** Os 365 processos ocupavam 171 MB — sexta linha num ranking por
  tamanho. A prova certa é tempo de parede de trabalho fixo contra a melhor marca da máquina.
- **Divisão de papéis:** reckon julga e entrega o comando (nunca mata); notch percebe e avisa.
- **Nunca matar por nome.** A lei de `teste-de-freios.sh` vale para `sob-carga.sh`: mata-se
  o PID que o próprio script criou. Provado com decoy.
- **Commits direto em `main`** nos dois repos, seguindo o histórico linear deles.

## Descobertas

- **PPID 1 significa duas coisas opostas** e a tabela de processos desenha igual: órfão
  reparentado, e agente que o launchd/LaunchServices criou assim. A primeira versão ofereceu
  matar 21 `distnoted`. Três redes, e só **1 dos 21** aparece em `launchctl list`.
- **O listener costuma ser neto do órfão.** `npm exec next dev` é o órfão; o `next-server`
  dois níveis abaixo segura a porta. A primeira versão perdia todo servidor que importava.
- **`swapStats()` responde em MB** — o contrato avisa em negrito e eu li `.usedKB`.
- **O painel é um servidor numa porta.** Sem exclusão do próprio processo, o reckon ofereceria
  um `kill` na página que você está lendo. A porta padrão dele (4127) tinha um reckon de 8 dias.
- **`0` dentro de trap de sinal não é o código do sinal** — Ctrl-C saía 0.
- **O `claude -p` de 23h não era sessão parada**, era o cérebro do Notch.app rodando. Matar
  teria quebrado o app em uso.

## Open Items

- **A aba `Pressure` não foi verificada visualmente** — a extensão do Chrome não estava
  conectada. Rota, HTML, JS e ids conferidos; o desenho, não.
- **Acender o notch em REPOUSO** ficou de fora: mexe na `GeometriaDoNotch` ou tinge a
  `BordaViva`, e é decisão de desenho dele.
- **Sobrou lixo na máquina, não tocado:** `next dev` na 3010 (5 dias) e na 5174 (7 dias),
  reckon na 4127 (8 dias), um Python órfão de 10 dias. Opera em 3,9 GB é o maior consumidor.
- **`graphify-gate` falhou** na auditoria: `unknown command 'run'` — a CLI instalada não
  bate com o que a skill chama. Descompasso de versão, não problema do repo.
- Nenhum push feito.

## Suggested Next Steps

1. `npm start` no reckon e abrir `#pressure` — confirmar que a aba desenha.
2. Decidir a superfície ambiente do notch (borda tingida vs. glifo) se quiser alarme com o
   notch fechado.
3. Push dos dois repos, se quiser.
