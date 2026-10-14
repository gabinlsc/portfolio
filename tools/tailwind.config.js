// Config Tailwind du Hub (index.html). Compiler avec : npm run build:css
module.exports = Object.assign({
      theme: {
        extend: {
          fontFamily: {
            display: ['Fredoka', 'system-ui', 'sans-serif'],
            body: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
          },
          colors: {
            cream: '#FFFDF0',
            ink: '#111111',
            banana: '#FFD84D',
            mint: '#7BE0AD',
            lilac: '#C3A6FF',
            sky: '#8FD3FF',
            coral: '#FF9478',
            peach: '#FFC9A8',
          },
          borderWidth: { 3: '3px' },
          boxShadow: {
            pop: '4px 4px 0 #000',
            'pop-sm': '2px 2px 0 #000',
            'pop-lg': '6px 6px 0 #000',
          },
        },
      },
    }, {
  content: ['./index.html', './assets/_glsc/hub.js'],
});
