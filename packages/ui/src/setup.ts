// Side-effect entry: import once, before rendering <App />.
// The React 19 adapter must load before any Arco component renders imperatively (Message, Modal …).
import '@arco-design/web-react/es/_util/react-19-adapter';
import './styles/global.css';
import { applyStoredThemeEarly } from './theme/themePreference';

applyStoredThemeEarly();
