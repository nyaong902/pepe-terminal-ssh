// src/utils/terminalThemes.ts
// xterm ITheme 프리셋 색구성표

export type TerminalTheme = {
  name: string;
  theme: Record<string, string | string[]>;
};

export const terminalThemes: TerminalTheme[] = [
  {
    name: 'Default Dark',
    theme: {
      background: '#000000',
      foreground: '#eeeeee',
      cursor: '#eeeeee',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(255,255,255,0.15)',
      black: '#000000', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
      blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
      brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeee',
    },
  },
  {
    name: 'Solarized Dark',
    theme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: 'rgba(147,161,161,0.2)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    name: 'Solarized Light',
    theme: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#586e75',
      cursorAccent: '#fdf6e3',
      selectionBackground: 'rgba(88,110,117,0.2)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    name: 'Monokai',
    theme: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      cursorAccent: '#272822',
      selectionBackground: 'rgba(73,72,62,0.5)',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75',
      brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
  },
  {
    name: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: 'rgba(68,71,90,0.5)',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    name: 'Nord',
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: 'rgba(67,76,94,0.5)',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  {
    name: 'One Dark',
    theme: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#282c34',
      selectionBackground: 'rgba(62,68,81,0.5)',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  },
  {
    name: 'Gruvbox Dark',
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: 'rgba(168,153,132,0.25)',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
  {
    name: 'Tomorrow Night',
    theme: {
      background: '#1d1f21',
      foreground: '#c5c8c6',
      cursor: '#c5c8c6',
      cursorAccent: '#1d1f21',
      selectionBackground: 'rgba(55,59,65,0.5)',
      black: '#1d1f21', red: '#cc6666', green: '#b5bd68', yellow: '#f0c674',
      blue: '#81a2be', magenta: '#b294bb', cyan: '#8abeb7', white: '#c5c8c6',
      brightBlack: '#969896', brightRed: '#cc6666', brightGreen: '#b5bd68', brightYellow: '#f0c674',
      brightBlue: '#81a2be', brightMagenta: '#b294bb', brightCyan: '#8abeb7', brightWhite: '#ffffff',
    },
  },
  {
    name: 'Ubuntu',
    theme: {
      background: '#300a24',
      foreground: '#eeeeec',
      cursor: '#eeeeec',
      cursorAccent: '#300a24',
      selectionBackground: 'rgba(238,238,236,0.2)',
      black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
      blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
      brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeee',
    },
  },
  {
    name: 'Tango',
    theme: {
      background: '#000000',
      foreground: '#00ff00',
      cursor: '#00ff00',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(0,255,0,0.2)',
      black: '#000000', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
      blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
      brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeee',
    },
  },
  {
    name: 'Retro Green',
    theme: {
      background: '#0a0a0a',
      foreground: '#33ff33',
      cursor: '#33ff33',
      cursorAccent: '#0a0a0a',
      selectionBackground: 'rgba(51,255,51,0.2)',
      black: '#0a0a0a', red: '#ff3333', green: '#33ff33', yellow: '#ffff33',
      blue: '#3333ff', magenta: '#ff33ff', cyan: '#33ffff', white: '#cccccc',
      brightBlack: '#666666', brightRed: '#ff6666', brightGreen: '#66ff66', brightYellow: '#ffff66',
      brightBlue: '#6666ff', brightMagenta: '#ff66ff', brightCyan: '#66ffff', brightWhite: '#ffffff',
    },
  },
  {
    name: 'Flat',
    theme: {
      background: '#002240',
      foreground: '#2cc55d',
      cursor: '#e5be0c',
      cursorAccent: '#002240',
      selectionBackground: 'rgba(44,197,93,0.2)',
      black: '#222d3f', red: '#a82320', green: '#32a548', yellow: '#e58d11',
      blue: '#3167ac', magenta: '#781aa0', cyan: '#2c9370', white: '#b0b6ba',
      brightBlack: '#475262', brightRed: '#d4312e', brightGreen: '#2d9440', brightYellow: '#e5be0c',
      brightBlue: '#3c7dd2', brightMagenta: '#8230a7', brightCyan: '#35b387', brightWhite: '#e7eced',
    },
  },
];

export function getThemeByName(name: string): Record<string, string | string[]> {
  return terminalThemes.find(t => t.name === name)?.theme ?? terminalThemes[0].theme;
}

export function getThemeList(): string[] {
  return terminalThemes.map(t => t.name);
}
