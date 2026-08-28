# Traço 3D

Editor web de projeções ortográficas em primeiro diedro com reconstrução instantânea de sólidos ortogonais.

## Executar

Requisitos: Node.js 20.19 ou mais recente.

```powershell
npm.cmd install
npm.cmd run dev
```

Abra o endereço exibido pelo Vite, normalmente `http://localhost:5173`.

Para gerar a versão estática:

```powershell
npm.cmd run build
```

Os arquivos finais são criados em `dist/`.

### HTML único para Google Sites

```powershell
npm.cmd run build:single
```

Esse comando cria `google-sites/index.html` com CSS, JavaScript, Three.js e controles 3D incorporados no próprio documento. O arquivo não depende de CDN nem de arquivos auxiliares e pode ser copiado no campo **Incorporar código** do Google Sites.

No Google Sites, dê ao bloco incorporado altura suficiente para a área de trabalho. Para uma experiência melhor, também é possível criar uma página com **Incorporação de página inteira**.

## Como desenhar

1. Escolha **Visível** e arraste entre dois pontos do grid. Linhas horizontais, verticais e diagonais são aceitas. Segure `Shift` para encaixar em intervalos de `0,5`.
2. Feche um contorno em cada uma das três vistas.
3. A região fechada recebe uma cor azul-clara e passa a representar matéria.
4. O modelo é reconstruído automaticamente pela interseção das três projeções.
5. Use **Oculta** para representar arestas tracejadas. Elas são informativas nesta versão e não alteram a geometria.
6. Selecione **Apagar** e clique em uma linha para removê-la.

Atalhos: `V` para linha visível, `O` para linha oculta, `E` para apagar, `Shift` para meia unidade, `Ctrl+Z` para desfazer e `Ctrl+Y` para refazer.

## Escopo atual

O protótipo trabalha com peças alinhadas aos eixos X, Y e Z, contornos ortogonais fechados e medidas inteiras no grid. A reconstrução gera o sólido visual compatível com as três silhuetas. Em desenhos ambíguos, mais de um sólido pode possuir as mesmas projeções.

O sistema também reconhece telhados de quatro águas proporcionais: retângulo, cumeeira e quatro espigões na vista superior; trapézio na frontal; e triângulo na lateral. Nesse caso, são produzidos quatro planos inclinados contínuos em vez de células voxelizadas.

Os projetos são salvos automaticamente no navegador. Também podem ser exportados e importados como arquivos `.traco3d.json`.

## PDF técnico editável

O botão **Exportar PDF** cria uma folha A4 paisagem com as vistas frontal, lateral esquerda e superior em primeiro diedro, além da perspectiva isométrica. O PDF incorpora os dados completos do editor em seus metadados.

Para continuar editando, use **Abrir** e selecione o próprio arquivo `.pdf`. PDFs comuns, sem dados Traço 3D incorporados, são recusados sem alterar o projeto atual.

As três vistas usam grid 10×10 e mostram coordenadas inicialmente. A opção **Projetantes** ativa linhas de correspondência entre frontal/superior e frontal/lateral, mais curvas de transferência entre superior/lateral. Quando estiver ativa, essa camada também aparece no PDF.
