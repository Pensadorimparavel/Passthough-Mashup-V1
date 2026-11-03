# Arquitetura GBA — Passthough Mashup

## Objetivo desta etapa

Criar um núcleo reutilizável para mashups entre jogos de GBA. O núcleo não conhece endereços de RAM específicos de Minish Cap ou Buu's Fury. Cada jogo entra por um adaptador próprio.

## Camadas

1. **mGBA Worker Adapter** — ciclo de frame, framebuffer, botões independentes e leitura limitada de memória.
2. **Game Decoder** — converte dados específicos de um jogo para o estado canônico. Só publica posição quando os campos e unidades forem identificados.
3. **Mashup Protocol** — mensagens versionadas com origem, destino, sequência, frame e payload.
4. **Mashup Runtime** — avança os dois jogos independentemente e encaminha o estado do provider ao host.
5. **Host Renderer / Gameplay Adapter** — responsabilidade posterior: converter coordenadas do provider para o mundo do host e implementar desenho, colisão e regras de jogo.

## Contrato de entidade

- `position.x/y`: coordenadas do mundo do jogo, não pixels da tela.
- `coordinateSpace`: identificação explícita do sistema de coordenadas.
- `confidence`: `experimental`, `probable` ou `verified`.
- `velocity`, `facing` e `animation`: opcionais até serem confirmados.

Um valor bruto de RAM não pode ser promovido a posição só porque muda durante o movimento. O decoder do jogo precisa validar escala, sinal, eixo, origem e comportamento em repouso.

## Segurança e integridade

- O núcleo usa somente `runFrame`, `framebuffer`, `setKeys` e `readMemoryRange`.
- Não existe API de escrita de RAM neste contrato.
- Leituras ficam limitadas a EWRAM (0x02000000–0x0203FFFF) e IWRAM (0x03000000–0x03007FFF).
- Os botões de cada Worker permanecem independentes.
- O núcleo não distribui ROMs nem incorpora conteúdo protegido.

## Estado atual e próximo trabalho

Este commit estabelece o contrato e o runtime comum. Ainda não declara posição de personagem confirmada para Buu's Fury. O próximo incremento é implementar decoders específicos, começando por um campo de posição confirmado em cada jogo; depois, conectar o renderer do host e só então experimentar colisões.
