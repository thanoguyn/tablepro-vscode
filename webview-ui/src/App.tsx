import React from 'react';
import ConnectionForm from './panels/ConnectionForm/ConnectionForm';
import DataGrid from './panels/DataGrid/DataGrid';
import StructureView from './panels/StructureView/StructureView';
import ERDiagram from './panels/ERDiagram/ERDiagram';
import QueryPlanView from './panels/QueryPlan/QueryPlanView';
import QuickView from './panels/QuickView/QuickView';

declare global {
  interface Window {
    __PANEL_TYPE__: string;
  }
}

export default function App() {
  const panelType = window.__PANEL_TYPE__ || 'connectionForm';

  switch (panelType) {
    case 'connectionForm':
      return <ConnectionForm />;
    case 'dataGrid':
      return <DataGrid />;
    case 'structureView':
      return <StructureView />;
    case 'erDiagram':
      return <ERDiagram />;
    case 'queryPlan':
      return <QueryPlanView />;
    case 'quickView':
      return <QuickView />;
    default:
      return <div style={{ padding: 20, color: 'var(--vscode-foreground)' }}>Unknown panel: {panelType}</div>;
  }
}
