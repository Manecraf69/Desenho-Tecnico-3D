# Traço 3D

Editor de projeções ortográficas com reconstrução instantânea de sólidos.

## Publicação

Este projeto é distribuído como um único arquivo estático: `index.html`.

Para publicar, hospede ou incorpore diretamente o `index.html` da raiz. Ele contém o HTML, CSS e JavaScript do projeto e carrega o Three.js e o OrbitControls por CDN, com versões fixas. Não depende de servidor backend, banco de dados ou processo de build.

A pasta `assets/` contém arquivos auxiliares do repositório, mas não é necessária para executar a versão atual do editor.

## Uso

- Desenhe as vistas frontal, lateral esquerda e superior no grid.
- Use as ferramentas de linhas visíveis, ocultas, elipse e apagar.
- Na ferramenta **Elipse**, arraste a caixa delimitadora. Segure **Shift** durante
  o arrasto para criar uma meia elipse; conecte suas pontas com linhas para
  formar perfis semicirculares e bordas arredondadas.
- Elipses fechadas dentro de um perfil são reconstruídas como furos passantes;
  elipses compatíveis nas três vistas geram esfera/elipsoide suave.
- Qualquer contorno fechado dentro do contorno externo (círculo, quadrado ou
  polígono) é interpretado como furo em qualquer uma das três vistas. As linhas
  ocultas correspondentes nas outras duas vistas definem sua profundidade e
  distinguem furos cegos de furos passantes.
- Furos de vistas diferentes podem coexistir no mesmo sólido. A reconstrução
  combina as subtrações nos eixos X, Y e Z, inclusive quando um furo vertical
  passante encontra um furo frontal ou lateral cego.
- O sólido-base usa o contorno externo mais detalhado das vistas; diagonais de
  canto são extrudadas como chanfros antes da aplicação dos furos.
- A reconstrução do modelo acontece automaticamente quando as vistas são válidas.
- Os projetos podem ser salvos e abertos em JSON.
- O PDF técnico pode ser exportado quando houver geometria válida.

Os dados locais ficam salvos no navegador do usuário.
