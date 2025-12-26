const MIN_PORT = 20000
const MAX_PORT = 29999
const takenPortSet = new Set()
  
export const getPort = () => {
  let port = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1) + MIN_PORT);

  while(takenPortSet.has(port)) {
    port = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1) + MIN_PORT);
  }

  takenPortSet.add(port);

  return port;
};

export const removePort = (port) => {
  takenPortSet.delete(port)
};